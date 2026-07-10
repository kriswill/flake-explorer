// Shared extraction driver: manifest + selected configurations into the
// data dir, reusing the narHash-keyed cache. Both `extract` and `export`
// run this; it lives outside the CLI entry so tests can call it in-process.

import { mkdirSync } from "node:fs"
import { join } from "node:path"
import type { Manifest } from "../schema"
import { applyExtracted, extractAndPersist, reconcile } from "./cache"
import { buildManifest } from "./manifest"
import { checkNix } from "./run-nix"

export interface DriveFlags {
  out: string
  configs: string[] | "all" | null
  allSystems: boolean
  /** Seconds, per nix invocation. */
  timeout: number
}

/**
 * Extract the manifest and the requested configurations (skipping ones the
 * cache already covers) into flags.out, and write manifest.json there so the
 * data dir stays reconcilable for later runs. Returns the live manifest and
 * the resolved list of requested config ids.
 */
export async function extractToDir(
  flakeRef: string,
  flags: DriveFlags,
): Promise<{ manifest: Manifest; wanted: string[] }> {
  await checkNix()
  mkdirSync(join(flags.out, "config"), { recursive: true })

  console.log(`extracting manifest of ${flakeRef} ...`)
  const manifest = await buildManifest(flakeRef, {
    allSystems: flags.allSystems,
    timeoutMs: flags.timeout * 1000,
  })
  console.log(
    `  ${manifest.files.length} files, ${Object.keys(manifest.inputs).length} inputs, ` +
      `${manifest.configurations.length} configurations`,
  )
  for (const w of manifest.warnings) console.warn(`  warn: ${w}`)
  await reconcile(flags.out, manifest)

  const wanted =
    flags.configs === "all"
      ? manifest.configurations.map((c) => c.id)
      : (flags.configs ?? []).map((c) => {
          if (!c.includes("/")) throw new Error(`--configs takes kind/name ids, got: ${c}`)
          return c
        })

  for (const id of wanted) {
    const ref = manifest.configurations.find((c) => c.id === id)
    if (!ref) throw new Error(`no such configuration: ${id}`)
    if (ref.status === "ok") {
      console.log(`options of ${id} cached (narHash + extractor match), skipping`)
      continue
    }
    console.log(`extracting options of ${id} ...`)
    try {
      const r = await extractAndPersist(flags.out, flakeRef, manifest.flake.narHash, ref, {
        timeoutMs: flags.timeout * 1000,
        onProgress: (p) =>
          process.stdout.write(`\r  ${p.done}/${p.total} ${p.current.padEnd(40).slice(0, 40)}`),
      })
      process.stdout.write("\n")
      applyExtracted(ref, r)
      manifest.warnings.push(...r.warnings)
      const customized = r.data.options.filter((o) => o.customized).length
      console.log(
        `  ${r.data.options.length} options (${customized} customized) in ${(r.durationMs / 1000).toFixed(1)}s`,
      )
      for (const w of r.warnings) console.warn(`  warn: ${w}`)
    } catch (e) {
      process.stdout.write("\n")
      ref.status = "error"
      ref.error = String(e).split("\n")[0]
      console.error(`  error: ${ref.error}`)
    }
  }

  await Bun.write(join(flags.out, "manifest.json"), JSON.stringify(manifest satisfies Manifest))
  console.log(`wrote ${join(flags.out, "manifest.json")}`)

  return { manifest, wanted }
}
