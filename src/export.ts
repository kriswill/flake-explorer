// Single-file static export: compose the SPA plus every data document it
// could ask for into ONE standalone HTML file (loadJson resolves embedded
// <script type="application/json"> tags before fetching), so the page works
// with no server behind it — file://, a CDN, GitHub Pages.

import { join } from "node:path"
import { buildFlakeIndexes, resolveFile } from "../app/lib/indexes"
import { buildApp, pageHtml } from "./build-app"
import { tokenizeNix } from "./extract/highlight"
import { readInputFile } from "./extract/run-nix"
import { type ConfigData, type FileSource, type Manifest, makeFileId, parseFileId } from "./schema"

export interface ExportOptions {
  /** Data/cache dir holding the extracted config blobs (extractToDir's out). */
  outDir: string
  htmlPath: string
  /** self: the flake's own files + each input's flake.nix.
   *  all: additionally every file the exported configurations reference. */
  sources: "self" | "all"
  timeoutMs: number
  /** Config ids to embed (extractToDir's resolved --configs/--all list). */
  wanted: string[]
}

export interface ExportSummary {
  htmlBytes: number
  /** Embedded configuration ids. */
  configs: string[]
  /** Embedded source-file ids. */
  files: string[]
  warnings: string[]
}

export async function exportHtml(
  flakeRef: string,
  manifest: Manifest,
  opts: ExportOptions,
): Promise<ExportSummary> {
  const warnings: string[] = []
  const embeds: Record<string, unknown> = {}

  // Requested configurations, read back from the data dir (parsing validates
  // the blob). Anything not ok here failed extraction — its ref keeps the
  // error status and the static UI reports it.
  const configData = new Map<string, ConfigData>()
  for (const id of opts.wanted) {
    const ref = manifest.configurations.find((c) => c.id === id)
    if (ref?.status !== "ok") continue
    try {
      const data = (await Bun.file(join(opts.outDir, ref.dataFile)).json()) as ConfigData
      configData.set(id, data)
      embeds[ref.dataFile] = data
    } catch (e) {
      // Sidecar said ok but the blob is gone/corrupt — the manifest embed
      // below downgrades the ref to pending, so the UI stays honest.
      warnings.push(`configuration not exported: ${id} (${String(e).split("\n")[0]})`)
    }
  }

  // Source files to embed, id -> store path. Self files and each input's own
  // flake.nix always; with --sources all, everything the embedded configs'
  // fileIndex references. resolveFile is the client's own attribution logic
  // (pure TS), so embedded ids match what the UI will ask for exactly.
  const sources = new Map<string, string>()
  for (const f of manifest.files) sources.set(f.id, f.storePath)
  for (const input of Object.values(manifest.inputs)) {
    if (!input.storePath) continue
    const id = makeFileId({ kind: "input", input: input.name }, "flake.nix")
    if (!sources.has(id)) sources.set(id, `${input.storePath}/flake.nix`)
  }
  if (opts.sources === "all") {
    const fx = buildFlakeIndexes(manifest)
    for (const data of configData.values()) {
      for (const storePath of Object.keys(data.fileIndex)) {
        // Virtual pseudo-paths (nixpkgs declares _module.* under a relative
        // "lib/modules.nix") and <unknown-file> have no file behind them.
        if (!storePath.startsWith("/")) continue
        const meta = resolveFile(storePath, manifest, fx)
        if (meta.id === "inline" || sources.has(meta.id)) continue
        sources.set(meta.id, meta.storePath)
      }
    }
  }

  const fileIds: string[] = []
  for (const [fileId, storePath] of sources) {
    const text = await readSource(flakeRef, fileId, storePath, opts.timeoutMs, warnings)
    if (text === null) continue
    const tokens = await tokenizeNix(text).catch(() => [])
    embeds[`file/${encodeURIComponent(fileId)}`] = { text, tokens } satisfies FileSource
    fileIds.push(fileId)
  }

  // The embedded manifest goes in last so export warnings surface in the UI.
  // A config that is ok on disk but NOT embedded is downgraded to a fresh
  // pending ref — an "ok" claim without a blob behind it would be a lie.
  embeds["manifest.json"] = {
    ...manifest,
    configurations: manifest.configurations.map((c) =>
      configData.has(c.id) || c.status !== "ok"
        ? c
        : {
            id: c.id,
            kind: c.kind,
            name: c.name,
            dataFile: c.dataFile,
            status: "pending" as const,
          },
    ),
    warnings: [...manifest.warnings, ...warnings],
  } satisfies Manifest

  console.log(`building UI ...`)
  const title = `flake-explorer — ${manifest.flake.description ?? flakeRef}`
  const html = pageHtml(await buildApp(false), title, { embeds })
  const htmlBytes = await Bun.write(opts.htmlPath, html)

  const configs = [...configData.keys()]
  console.log(
    `wrote ${opts.htmlPath} (${(htmlBytes / 1024 / 1024).toFixed(1)} MB, ` +
      `${configs.length} configurations, ${fileIds.length} source files)`,
  )
  for (const w of warnings) console.warn(`  warn: ${w}`)
  return { htmlBytes, configs, files: fileIds, warnings }
}

/**
 * A store path can be stale (GC'd, or lazy-trees synthetic) or a directory
 * (`import ./dir`) — mirror serve's fallback: input-origin files re-fetch
 * through Nix (which also resolves the /default.nix directory case);
 * anything else is skipped with a warning.
 */
async function readSource(
  flakeRef: string,
  fileId: string,
  storePath: string,
  timeoutMs: number,
  warnings: string[],
): Promise<string | null> {
  try {
    const file = Bun.file(storePath)
    if (await file.exists()) return await file.text()
  } catch {
    // fall through to the input re-fetch
  }
  const parsed = parseFileId(fileId)
  if (parsed?.kind === "input") {
    try {
      return await readInputFile(flakeRef, parsed.input, parsed.relPath, timeoutMs)
    } catch (e) {
      warnings.push(`source not exported: ${fileId} (${String(e).split("\n")[0]})`)
      return null
    }
  }
  warnings.push(`source not exported: ${fileId} (${storePath} not readable)`)
  return null
}
