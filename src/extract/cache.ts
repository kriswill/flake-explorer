// Extraction cache: a config blob is fresh when its sidecar records the same
// cache key that a fresh extraction would use — a fingerprint of the
// extraction code itself (fingerprint.ts) plus the identity of the flake it
// was extracted from (CacheKey below). Sidecars live next to the blobs
// (config/<kind>.<name>.meta.json).

import { join, resolve, sep } from "node:path"
import type { ConfigRef, Manifest, PackageRef } from "../schema"
import { extractorFingerprint } from "./fingerprint"
import { extractOptions, type OptionsProgress, type OptionsResult } from "./options"
import { extractPackage, type PackageResult } from "./package"

/** The "what was extracted" half of the cache key (the code half is the extractor fingerprint). */
export interface CacheKey {
  /**
   * The flake's narHash when it has one; else its self store path, which is
   * content-addressed too — so a dirty local checkout still invalidates on
   * every source change instead of never.
   */
  flakeKey: string
  /**
   * Fingerprint over the resolved input set (the effective flake.lock).
   * Redundant when flakeKey pins a committed lock file, but catches input
   * drift the flake's own identity can't see — e.g. a flake without a
   * committed flake.lock re-resolving an unpinned input.
   */
  lockHash: string
}

export function cacheKeyOf(manifest: Pick<Manifest, "flake" | "inputs">): CacheKey {
  const hasher = new Bun.CryptoHasher("sha256")
  for (const name of Object.keys(manifest.inputs).sort()) {
    const i = manifest.inputs[name]!
    hasher.update(`${name}=${i.narHash ?? i.rev ?? i.url ?? ""}\n`)
  }
  return {
    flakeKey: manifest.flake.narHash ?? manifest.flake.path,
    lockHash: hasher.digest("hex").slice(0, 16),
  }
}

interface SidecarMeta {
  /** Both optional only so pre-CacheKey sidecars still parse; absent always means stale. */
  flakeKey?: string
  lockHash?: string
  /** extractorFingerprint() at write time. */
  extractor: string
  extractedAt: string
  /** Absent for package sidecars — "options" don't apply to a derivation. */
  optionCount?: number
  durationMs: number
  warnings: string[]
}

const sidecarPath = (outDir: string, ref: Pick<ConfigRef | PackageRef, "dataFile">) =>
  join(outDir, ref.dataFile.replace(/\.json$/, ".meta.json"))

export async function writeSidecar(
  outDir: string,
  ref: Pick<ConfigRef | PackageRef, "dataFile">,
  meta: Omit<SidecarMeta, "extractor">,
): Promise<void> {
  await Bun.write(
    sidecarPath(outDir, ref),
    JSON.stringify({ ...meta, extractor: await extractorFingerprint() }),
  )
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
  key: CacheKey,
  ref: Pick<ConfigRef, "kind" | "name" | "dataFile">,
  opts: { timeoutMs: number; onProgress?: (p: OptionsProgress) => void },
): Promise<OptionsResult & { extractedAt: string }> {
  // Defense in depth: dataFile derives from a Nix attr name (sanitized in
  // manifest.ts) — never let a hostile name write outside the data dir.
  const blobPath = join(outDir, ref.dataFile)
  if (!resolve(blobPath).startsWith(resolve(outDir) + sep)) {
    throw new Error(`refusing to write outside the data dir: ${ref.dataFile}`)
  }
  const r = await extractOptions(flakeRef, ref.kind, ref.name, opts)
  await Bun.write(blobPath, JSON.stringify(r.data))
  const extractedAt = new Date().toISOString()
  await writeSidecar(outDir, ref, {
    ...key,
    extractedAt,
    optionCount: r.data.options.length,
    durationMs: r.durationMs,
    warnings: r.warnings,
  })
  return { ...r, extractedAt }
}

/** Record a finished extraction on a (current-manifest) ConfigRef. */
export function applyExtracted(ref: ConfigRef, r: OptionsResult & { extractedAt: string }): void {
  ref.status = "ok"
  ref.extractedAt = r.extractedAt
  ref.optionCount = r.data.options.length
  ref.durationMs = r.durationMs
}

/**
 * Extraction driver for one derivation-typed output — mirrors
 * extractAndPersist above (same blob+sidecar shape, same path-traversal
 * guard), but calls extractPackage (package.ts) instead of extractOptions:
 * a package's structural source (a derivation) is different enough from a
 * NixOS options tree that sharing one function would just be an `if(kind)`
 * in disguise.
 */
export async function extractAndPersistPackage(
  outDir: string,
  flakeRef: string,
  key: CacheKey,
  ref: Pick<PackageRef, "id" | "path" | "dataFile">,
  opts: { timeoutMs: number },
): Promise<PackageResult & { extractedAt: string }> {
  const blobPath = join(outDir, ref.dataFile)
  if (!resolve(blobPath).startsWith(resolve(outDir) + sep)) {
    throw new Error(`refusing to write outside the data dir: ${ref.dataFile}`)
  }
  const r = await extractPackage(flakeRef, ref, opts)
  await Bun.write(blobPath, JSON.stringify(r.data))
  const extractedAt = new Date().toISOString()
  await writeSidecar(outDir, ref, {
    ...key,
    extractedAt,
    durationMs: r.durationMs,
    warnings: r.warnings,
  })
  return { ...r, extractedAt }
}

/** Record a finished extraction on a (current-manifest) PackageRef. */
export function applyExtractedPackage(
  ref: PackageRef,
  r: PackageResult & { extractedAt: string },
): void {
  ref.status = "ok"
  ref.extractedAt = r.extractedAt
  ref.durationMs = r.durationMs
}

type ReconcilableRef = Pick<ConfigRef, "dataFile" | "status" | "extractedAt" | "durationMs"> &
  Partial<Pick<ConfigRef, "optionCount">>

/** Shared freshness check: same sidecar body for both configurations and packages. */
async function reconcileRef(
  outDir: string,
  manifest: Manifest,
  fingerprint: string,
  key: CacheKey,
  ref: ReconcilableRef,
): Promise<void> {
  try {
    const blob = Bun.file(join(outDir, ref.dataFile))
    if (!(await blob.exists())) return
    const meta = (await Bun.file(sidecarPath(outDir, ref)).json()) as SidecarMeta
    if (meta.extractor !== fingerprint) return
    if (meta.flakeKey !== key.flakeKey || meta.lockHash !== key.lockHash) return
    ref.status = "ok"
    ref.extractedAt = meta.extractedAt
    ref.durationMs = meta.durationMs
    // Only ever set for ConfigRef sidecars — never stamped onto a PackageRef.
    if (meta.optionCount !== undefined) ref.optionCount = meta.optionCount
    manifest.warnings.push(...meta.warnings.map((w) => `[cached] ${w}`))
  } catch {
    // missing/corrupt sidecar — stays pending
  }
}

/**
 * Reconcile a freshly built manifest with blobs already on disk: refs whose
 * sidecar matches the current cache key (extractor fingerprint + flake
 * identity + lock hash) flip to "ok" so serve/extract skip re-evaluating
 * them. Runs over both configurations and packages.
 */
export async function reconcile(outDir: string, manifest: Manifest): Promise<void> {
  const fingerprint = await extractorFingerprint()
  const key = cacheKeyOf(manifest)
  for (const ref of manifest.configurations)
    await reconcileRef(outDir, manifest, fingerprint, key, ref)
  for (const ref of manifest.packages) await reconcileRef(outDir, manifest, fingerprint, key, ref)
}
