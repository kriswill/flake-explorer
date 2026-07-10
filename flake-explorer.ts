// flake-explorer CLI: extract flake structure/options to JSON, serve the SPA.
// A wrapper may set FLAKE_EXPLORER_PROG so usage shows the invoked name.

import { realpathSync } from "node:fs"
import { extractToDir } from "./src/extract/drive"
import { localFlakeDir } from "./src/extract/manifest"

const prog = process.env.FLAKE_EXPLORER_PROG ?? "bun flake-explorer.ts"

interface Flags {
  out: string
  configs: string[] | "all" | null
  allSystems: boolean
  timeout: number
  html: string
  sources: "self" | "all"
  port?: number
  dev: boolean
  positional: string[]
}

function parseFlags(argv: string[]): Flags {
  const f: Flags = {
    out: "./flake-explorer-data",
    configs: null,
    allSystems: false,
    timeout: 600,
    html: "./flake.html",
    sources: "self",
    dev: false,
    positional: [],
  }
  // A missing value (end of argv, or the next flag consumed as the value)
  // must be an error, not a silent default/NaN — a NaN timeout kills every
  // nix call instantly ("timed out after NaNs"), far from the actual typo.
  const arg = (flag: string, raw: string | undefined): string => {
    if (raw === undefined || raw.startsWith("--")) die(`${flag} expects a value`)
    return raw
  }
  const num = (flag: string, raw: string | undefined): number => {
    const v = arg(flag, raw)
    const n = Number(v)
    if (!Number.isFinite(n) || n <= 0) die(`${flag} expects a positive number, got: ${v}`)
    return n
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--out") f.out = arg(a, argv[++i])
    else if (a === "--configs") f.configs = arg(a, argv[++i]).split(",").filter(Boolean)
    else if (a === "--all") f.configs = "all"
    else if (a === "--all-systems") f.allSystems = true
    else if (a === "--timeout") f.timeout = num(a, argv[++i])
    else if (a === "--html") f.html = arg(a, argv[++i])
    else if (a === "--sources") {
      const v = arg(a, argv[++i])
      if (v !== "self" && v !== "all") die(`--sources expects self or all, got: ${v}`)
      f.sources = v
    } else if (a === "--port") f.port = num(a, argv[++i])
    else if (a === "--dev") f.dev = true
    else if (a.startsWith("--")) die(`unknown flag: ${a}`)
    else f.positional.push(a)
  }
  return f
}

function die(msg: string): never {
  console.error(`${prog}: ${msg}`)
  process.exit(1)
}

/**
 * Canonicalize path-like flakerefs: nix with lazy-trees disabled refuses a
 * flake root that is itself a symlink (/etc/nixos usually is one).
 */
function canonicalRef(ref: string): string {
  const dir = localFlakeDir(ref)
  if (!dir) return ref
  // Keep any ?query (e.g. ?dir=sub) — it's flake selection, not filesystem.
  return realpathSync(dir) + (ref.match(/\?.*$/)?.[0] ?? "")
}

async function cmdExtract(flags: Flags) {
  const flakeRef = canonicalRef(
    flags.positional[0] ?? die("usage: extract <flakeref> [--out DIR] [--configs a,b | --all]"),
  )
  await extractToDir(flakeRef, flags)
}

async function cmdExport(flags: Flags) {
  const flakeRef = canonicalRef(
    flags.positional[0] ??
      die("usage: export <flakeref> [--html FILE] [--configs a,b | --all] [--sources self|all]"),
  )
  const { manifest, wanted } = await extractToDir(flakeRef, flags)
  const { exportHtml } = await import("./src/export")
  await exportHtml(flakeRef, manifest, {
    outDir: flags.out,
    htmlPath: flags.html,
    sources: flags.sources,
    timeoutMs: flags.timeout * 1000,
    wanted,
  })
}

const [cmd, ...rest] = process.argv.slice(2)
const flags = parseFlags(rest)

switch (cmd) {
  case "extract":
    await cmdExtract(flags)
    break
  case "export":
    await cmdExport(flags)
    break
  case "serve": {
    const { serve } = await import("./src/serve")
    await serve(
      canonicalRef(
        flags.positional[0] ?? die("usage: serve <flakeref> [--port N] [--out DIR] [--dev]"),
      ),
      flags,
    )
    break
  }
  default:
    console.log(`usage: ${prog} <command> [args]

commands:
  extract <flakeref> [--out DIR] [--configs kind/name,... | --all] [--all-systems] [--timeout SECS]
      Extract manifest (+ selected configurations) to the data dir.
  export <flakeref> [--html FILE] [--out DIR] [--configs kind/name,... | --all] [--all-systems] [--sources self|all] [--timeout SECS]
      Extract, then write ONE standalone HTML file (default ./flake.html)
      that works without a server — file://, any CDN, GitHub Pages.
      --sources all also embeds every file the exported configurations
      reference (can be large against nixpkgs).
  serve <flakeref> [--port N] [--out DIR] [--dev]
      Extract manifest, then serve the explorer UI with on-demand
      per-configuration extraction. --dev watches app/ and live-reloads
      the browser (run under \`bun --watch\` to cover server files too).`)
    process.exit(cmd ? 1 : 0)
}
