// Extraction cache: a config blob is fresh when its sidecar records the same
// flake narHash and extractor version that produced it. Sidecars live next
// to the blobs (config/<kind>.<name>.meta.json).

import { join } from "node:path";
import { EXTRACTOR_VERSION, type ConfigRef, type Manifest } from "../schema";

interface SidecarMeta {
  narHash?: string;
  extractor: string;
  extractedAt: string;
  optionCount: number;
  durationMs: number;
  warnings: string[];
}

const sidecarPath = (outDir: string, ref: ConfigRef) => join(outDir, ref.dataFile.replace(/\.json$/, ".meta.json"));

export async function writeSidecar(
  outDir: string,
  ref: ConfigRef,
  meta: Omit<SidecarMeta, "extractor">,
): Promise<void> {
  await Bun.write(sidecarPath(outDir, ref), JSON.stringify({ ...meta, extractor: EXTRACTOR_VERSION }));
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
