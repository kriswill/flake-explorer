// Reverse-dependency index over the flake's OWN packages: "what in this flake
// depends on package X". The sound join key is drvPath — one package's
// DrvInfo.drvPath against another's DrvInfo.inputDrvs[].drvPath. The name-only
// deps.*BuildInputs are NOT soundly joinable (a bare name resolves to many
// drvs). Two distinct derivations never share a `.drv` path, so matches are
// false-positive-free; the index is silently PARTIAL over whatever package set
// it is given (flake packages mostly depend on nixpkgs drvs, which have no
// extracted blob — the UI states the scope honestly rather than implying it saw
// every dependent).

import type { PackageData } from "../schema"

/**
 * Depended-on package refId -> sorted refIds that depend on it, built from the
 * given package blobs only. Only this build point (static export, extract/
 * export.ts) has package drv data in hand; the cheap always-regenerated
 * manifest does not, so serve mode omits this and the SPA falls back to a
 * client-side index over loaded packages.
 */
export function buildPackageReverseDeps(
  packageData: Map<string, PackageData>,
): Record<string, string[]> {
  // drvPath -> owning refIds, so each inputDrv is an O(1) lookup rather than a
  // scan over every package. A LIST, not one id: an alias like
  // `packages.default = packages.myapp` gives two refIds the SAME drvPath, and
  // both must be credited or one alias's page falsely reads "0 dependents".
  const byDrv = new Map<string, string[]>()
  for (const [id, data] of packageData) {
    if (!data.drv?.drvPath) continue
    const owners = byDrv.get(data.drv.drvPath)
    if (owners) owners.push(id)
    else byDrv.set(data.drv.drvPath, [id])
  }

  const reverse: Record<string, string[]> = {}
  for (const [id, data] of packageData) {
    // A drv can list the same input twice (multiple outputs) — dedupe per
    // dependent so a package appears once under each thing it depends on.
    const seen = new Set<string>()
    for (const inp of data.drv?.inputDrvs ?? []) {
      for (const dep of byDrv.get(inp.drvPath) ?? []) {
        if (dep === id || seen.has(dep)) continue // skip self-edges and repeats
        seen.add(dep)
        if (!reverse[dep]) reverse[dep] = []
        reverse[dep].push(id)
      }
    }
  }
  for (const k of Object.keys(reverse)) reverse[k]!.sort()
  return reverse
}
