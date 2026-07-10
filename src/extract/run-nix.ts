// Thin wrapper around the host's `nix` binary. The nix on PATH is deliberately
// the user's own (never vendored by package.nix) so store paths and the flake
// registry match their system. All calls are JSON-in/JSON-out with a timeout
// and errors surfaced with the underlying stderr attached.

import { join } from "node:path"

export class NixError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
    public readonly exitCode: number | null,
  ) {
    super(message)
    this.name = "NixError"
  }
}

const MIN_NIX = [2, 19]

/** Throws with a clear message when nix is missing or too old. */
export async function checkNix(): Promise<string> {
  let out: string
  try {
    out = await run(["--version"], 10_000)
  } catch {
    throw new Error(
      "flake-explorer needs `nix` on PATH (>= 2.19 with flakes enabled) — none found.",
    )
  }
  // e.g. "nix (Nix) 2.34.7" or "nix (Determinate Nix 3.21.1) 2.34.7"
  const m = out.match(/\s(\d+)\.(\d+)\.\d+\s*$/m)
  if (m) {
    const [maj, min] = [Number(m[1]), Number(m[2])]
    if (maj < MIN_NIX[0]! || (maj === MIN_NIX[0] && min < MIN_NIX[1]!)) {
      throw new Error(`flake-explorer needs nix >= ${MIN_NIX.join(".")}, found: ${out.trim()}`)
    }
  }
  return out.trim()
}

// Lazy trees (Determinate Nix) mint per-access-route virtual store paths, so
// the same input shows up under many roots and nothing joins across evals.
// Force real content-addressed paths; on nix variants without the setting
// this is just an "unknown setting" warning.
const COMMON_OPTS = ["--option", "lazy-trees", "false"]

async function run(args: string[], timeoutMs: number): Promise<string> {
  // env passed explicitly: without it Bun.spawn resolves the executable
  // against the process's STARTUP PATH, ignoring runtime process.env.PATH
  // changes (which the test shim relies on).
  const proc = Bun.spawn(["nix", ...COMMON_OPTS, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  })
  // Not signal: AbortSignal.timeout(timeoutMs) — some test/runtime setups
  // (e.g. this repo's happy-dom preload) replace the global AbortSignal, and
  // Bun.spawn rejects a signal instance that isn't identically its own class.
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, timeoutMs)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).finally(() => clearTimeout(timer))
  if (timedOut) {
    throw new NixError(`nix ${args[0]} timed out after ${timeoutMs / 1000}s`, stderr, exitCode)
  }
  if (exitCode !== 0) {
    const tail = stderr.trim().split("\n").slice(-15).join("\n")
    throw new NixError(
      `nix ${args.slice(0, 3).join(" ")} failed (exit ${exitCode}):\n${tail}`,
      stderr,
      exitCode,
    )
  }
  return stdout
}

export async function runJson<T>(args: string[], timeoutMs: number): Promise<T> {
  return JSON.parse(await run(args, timeoutMs)) as T
}

/** `nix flake metadata --json <ref>` */
export function flakeMetadata(ref: string, timeoutMs = 120_000): Promise<FlakeMetadataJson> {
  return runJson(["flake", "metadata", "--json", ref], timeoutMs)
}

/** `nix flake show --json <ref>` */
export function flakeShow(ref: string, allSystems: boolean, timeoutMs = 300_000): Promise<unknown> {
  const args = ["flake", "show", "--json", ref]
  if (allSystems) args.splice(3, 0, "--all-systems")
  return runJson(args, timeoutMs)
}

/**
 * Evaluate extract.nix with the given args. The args object is passed through
 * JSON twice: a JSON string literal is a valid Nix string literal, so
 * JSON.stringify(JSON.stringify(args)) drops straight into the expression
 * with no Nix escaping of our own.
 */
export function evalExtract<T>(args: ExtractArgs, timeoutMs: number): Promise<T> {
  const extractNix = join(import.meta.dir, "extract.nix")
  const expr = `import ${extractNix} (builtins.fromJSON ${JSON.stringify(JSON.stringify(args))})`
  return runJson<T>(["eval", "--impure", "--json", "--expr", expr], timeoutMs)
}

/**
 * Read a file out of a flake input directly through Nix, bypassing the store
 * path entirely. A cached ConfigData blob's declaration/definition file
 * strings are store paths frozen at extraction time — they 404 once GC has
 * swept that input's (usually unrooted) source tree, or under lazy-trees
 * (Determinate Nix), which mints synthetic per-access-route paths that were
 * never a real on-disk directory to begin with. `getFlake` + `readFile`
 * re-resolves/re-fetches the input as needed instead of trusting a stale path.
 */
export async function readInputFile(
  flakeRef: string,
  inputName: string,
  relPath: string,
  timeoutMs = 60_000,
): Promise<string> {
  try {
    return await readInputFileRaw(flakeRef, inputName, relPath, timeoutMs)
  } catch (e) {
    // A directory-mounted "module" (import ./modules/sops) records its id/relPath
    // as the directory itself; Nix resolves the same import to default.nix.
    if (e instanceof NixError && /Is a directory/.test(e.stderr)) {
      return readInputFileRaw(flakeRef, inputName, `${relPath}/default.nix`, timeoutMs)
    }
    throw e
  }
}

function readInputFileRaw(
  flakeRef: string,
  inputName: string,
  relPath: string,
  timeoutMs: number,
): Promise<string> {
  const expr = `builtins.readFile ((builtins.getFlake ${JSON.stringify(flakeRef)}).inputs.${JSON.stringify(inputName)} + ${JSON.stringify(`/${relPath}`)})`
  return run(["eval", "--impure", "--raw", "--expr", expr], timeoutMs)
}

export interface ExtractArgs {
  flakeRef: string
  mode: "manifest" | "options" | "optionNames"
  name?: string
  kind?: "nixos" | "darwin"
  /** options/optionNames mode: option path of the subtree to walk. */
  path?: string[]
  /** options mode: restrict the walk to these children of `path`. */
  childNames?: string[]
  skipInvisible?: boolean
  withValues?: boolean
  withDescriptions?: boolean
}

// Shapes of the raw nix JSON we consume (subset).
export interface FlakeMetadataJson {
  description?: string
  path: string
  resolvedUrl: string
  url: string
  revision?: string
  locked?: { narHash?: string; rev?: string }
  locks: {
    version: number
    root: string
    nodes: Record<string, LockNode>
  }
}

export interface LockNode {
  inputs?: Record<string, string | string[]>
  locked?: {
    type: string
    narHash?: string
    rev?: string
    ref?: string
    owner?: string
    repo?: string
    url?: string
    path?: string
    lastModified?: number
  }
  original?: {
    type?: string
    url?: string
    ref?: string
    owner?: string
    repo?: string
    path?: string
  }
  flake?: boolean
}

export interface InputsTreeNode {
  /** Store path of the input's source ("path" — see extract.nix outPath note). */
  path: string | null
  inputs: Record<string, InputsTreeNode>
}

export interface ManifestEval {
  self: string
  description: string | null
  inputs: Record<string, InputsTreeNode>
  configurations: { kind: "nixos" | "darwin"; n: string }[]
  files: string[]
  grafts: { output: string; input: string; added: string[]; inherited: number }[]
  outputNames: Record<string, string[]>
}

export interface OptionsEval {
  options: RawOption[]
}

/** Envelope from extract.nix deepSafe: value | error | skipped-as-unsafe. */
export type ValueEnvelope = { ok: unknown } | { err: true } | { skipped: true } | null

export interface RawOption {
  loc: string[]
  type: string | null
  description: string | null
  readOnly: boolean
  isDefined: boolean
  highestPrio: number | null
  defaultText: string | null
  default: ValueEnvelope
  value: ValueEnvelope
  declarations: string[]
  definitions: { file: string; value: ValueEnvelope }[]
}
