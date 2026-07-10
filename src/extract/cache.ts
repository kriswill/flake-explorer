// Extraction cache: a config blob is fresh when its sidecar records the same
// flake narHash and extractor version that produced it. Sidecars live next
// to the blobs (config/<kind>.<name>.meta.json).

import { join, resolve, sep } from "node:path";
import { EXTRACTOR_VERSION, type ConfigRef, type Manifest } from "../schema";
import { extractOptions, type OptionsProgress, type OptionsResult } from "./options";

interface SidecarMeta {
  narHash?: string;
  extractor: string;
  extractedAt: string;
  optionCount: number;
  durationMs: number;
  warnings: string[];
}

const sidecarPath = (outDir: string, ref: Pick<ConfigRef, "dataFile">) =>
  join(outDir, ref.dataFile.replace(/\.json$/, ".meta.json"));

export async function writeSidecar(
  outDir: string,
  ref: Pick<ConfigRef, "dataFile">,
  meta: Omit<SidecarMeta, "extractor">,
): Promise<void> {
  await Bun.write(sidecarPath(outDir, ref), JSON.stringify({ ...meta, extractor: EXTRACTOR_VERSION }));
}

/**
 * Extraction driver shared by the CLI (`extract`) and `serve`: evaluate one
 * configuration's options, write the blob + sidecar. Deliberately does NOT
 * touch the ConfigRef — the caller applies the outcome (applyExtracted) to
 * whichever manifest is current when the extraction settles, since serve's
 * /api/refresh can swap the manifest mid-extraction.
 */
export async function extractAndPersist(
  outDir: string,
  flakeRef: string,
  narHash: string | undefined,
  ref: Pick<ConfigRef, "kind" | "name" | "dataFile">,
  opts: { timeoutMs: number; onProgress?: (p: OptionsProgress) => void },
): Promise<OptionsResult & { extractedAt: string }> {
  // Defense in depth: dataFile derives from a Nix attr name (sanitized in
  // manifest.ts) — never let a hostile name write outside the data dir.
  const blobPath = join(outDir, ref.dataFile);
  if (!resolve(blobPath).startsWith(resolve(outDir) + sep)) {
    throw new Error(`refusing to write outside the data dir: ${ref.dataFile}`);
  }
  const r = await extractOptions(flakeRef, ref.kind, ref.name, opts);
  await Bun.write(blobPath, JSON.stringify(r.data));
  const extractedAt = new Date().toISOString();
  await writeSidecar(outDir, ref, {
    narHash,
    extractedAt,
    optionCount: r.data.options.length,
    durationMs: r.durationMs,
    warnings: r.warnings,
  });
  return { ...r, extractedAt };
}

/** Record a finished extraction on a (current-manifest) ConfigRef. */
export function applyExtracted(ref: ConfigRef, r: OptionsResult & { extractedAt: string }): void {
  ref.status = "ok";
  ref.extractedAt = r.extractedAt;
  ref.optionCount = r.data.options.length;
  ref.durationMs = r.durationMs;
}

/**
 * Reconcile a freshly built manifest with blobs already on disk: configs
 * whose sidecar matches (narHash + extractor) flip to "ok" so serve/extract
 * skip re-evaluating them.
 */
export async function reconcile(outDir: string, manifest: Manifest): Promise<void> {
  for (const ref of manifest.configurations) {
    try {
      const blob = Bun.file(join(outDir, ref.dataFile));
      if (!(await blob.exists())) continue;
      const meta = (await Bun.file(sidecarPath(outDir, ref)).json()) as SidecarMeta;
      if (meta.extractor !== EXTRACTOR_VERSION) continue;
      if (manifest.flake.narHash && meta.narHash !== manifest.flake.narHash) continue;
      ref.status = "ok";
      ref.extractedAt = meta.extractedAt;
      ref.optionCount = meta.optionCount;
      ref.durationMs = meta.durationMs;
      manifest.warnings.push(...meta.warnings.map((w) => `[cached] ${w}`));
    } catch {
      // missing/corrupt sidecar — stays pending
    }
  }
}
