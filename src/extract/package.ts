// Orchestrates extraction of one derivation-typed output (package, devShell,
// check, or formatter): eval (name/pname/version/meta/deps/markers) + `nix
// derivation show` (drv-level: builder, phases, input drvs — instantiation
// only, never builds) + `nix path-info` per output (query-only; present only
// when that output is already realized in the local store). Mirrors
// options.ts's extractOptions lifecycle but for a structurally different
// source (a derivation, not a NixOS options tree).

import {
  type BuilderKind,
  type DrvInfo,
  type DrvInputRef,
  type DrvPhase,
  type PackageData,
  type PackageLicense,
  type PackageMaintainer,
  type PackageMeta,
  type PackageRef,
  type RuntimeInfo,
  SCHEMA_VERSION,
} from "../schema"
import { derivationShow, evalExtract, type PackageEval, pathInfo } from "./run-nix"

export interface PackageResult {
  data: PackageData
  warnings: string[]
  durationMs: number
}

export async function extractPackage(
  flakeRef: string,
  ref: Pick<PackageRef, "id" | "path">,
  opts: { timeoutMs: number },
): Promise<PackageResult> {
  const start = Date.now()
  const warnings: string[] = []

  const ev = await evalExtract<PackageEval>(
    { flakeRef, mode: "package", path: ref.path },
    opts.timeoutMs,
  )

  if (!ev.isDrv) {
    throw new Error(`${ref.id} is not a derivation (output may have changed since the last refresh)`)
  }
  if (ev.metaError) {
    warnings.push(`meta unavailable for ${ref.id} (broken/unfree package?)`)
  }

  let drv: DrvInfo | undefined
  try {
    const raw = await derivationShow(flakeRef, ref.path, opts.timeoutMs)
    drv = normalizeDerivationShow(raw) ?? undefined
    if (!drv) warnings.push(`${ref.id}: derivation show returned no entry`)
  } catch (e) {
    warnings.push(`${ref.id}: derivation show failed: ${String(e).split("\n")[0]}`)
  }

  const runtime: Record<string, RuntimeInfo> = {}
  for (const out of ev.outputs) {
    if (!out.path) continue
    try {
      const info = await pathInfo(out.path, opts.timeoutMs)
      if (info) {
        runtime[out.name] = {
          outPath: out.path,
          references: info.references,
          narSize: info.narSize,
          closureSize: info.closureSize,
        }
      }
    } catch (e) {
      warnings.push(`${ref.id}: path-info failed for output "${out.name}": ${String(e).split("\n")[0]}`)
    }
  }

  const data: PackageData = {
    version: SCHEMA_VERSION,
    id: ref.id,
    path: ref.path,
    name: ev.name ?? undefined,
    pname: ev.pname ?? undefined,
    pkgVersion: ev.pkgVersion ?? undefined,
    builder: classifyBuilder(ev.markers, ev.deps.nativeBuildInputs, (drv?.phases.length ?? 0) > 0),
    stdenv: ev.stdenv ?? undefined,
    system: ev.system ?? undefined,
    meta: ev.meta ? normalizePackageMeta(ev.meta) : undefined,
    src: ev.src
      ? {
          storePath: ev.src.storePath ?? undefined,
          url: ev.src.url ?? undefined,
          rev: ev.src.rev ?? undefined,
          outputHash: ev.src.outputHash ?? undefined,
        }
      : undefined,
    outputs: ev.outputs.map((o) => ({ name: o.name, outPath: o.path ?? undefined })),
    deps: ev.deps,
    drv,
    runtime: Object.keys(runtime).length > 0 ? runtime : undefined,
    warnings,
  }

  return { data, warnings, durationMs: Date.now() - start }
}

// --------------------------------------------------------- classifyBuilder

/** nativeBuildInputs name substrings that identify a language-specific build hook. */
const HOOK_MARKERS: { pattern: RegExp; kind: BuilderKind }[] = [
  { pattern: /cargo-build-hook|rust-cargo/i, kind: "rustPlatform" },
  { pattern: /go-modules-hook/i, kind: "buildGoModule" },
  { pattern: /npm-install-hook|node-gyp/i, kind: "node" },
]

/**
 * markers (from eval: `pkg ? cargoDeps` etc.) first, then a nativeBuildInputs
 * hook-name scan (catches e.g. a rustPlatform-built package reached through a
 * wrapper that doesn't itself carry cargoDeps), then phase presence -> a
 * plain stdenv derivation, else unknown.
 */
export function classifyBuilder(
  markers: { cargoDeps: boolean; goModules: boolean; npmDeps: boolean; buildCommand: boolean },
  nativeBuildInputs: string[],
  hasPhases: boolean,
): BuilderKind {
  if (markers.cargoDeps) return "rustPlatform"
  if (markers.goModules) return "buildGoModule"
  if (markers.npmDeps) return "node"
  if (markers.buildCommand) return "trivial"
  for (const dep of nativeBuildInputs) {
    for (const h of HOOK_MARKERS) if (h.pattern.test(dep)) return h.kind
  }
  if (hasPhases) return "stdenv"
  return "unknown"
}

// ---------------------------------------------------- normalizeDerivationShow

const PHASE_CAP = 4000

/** Main build phases in execution order, each with its pre/post hook variable. */
const PHASE_ORDER: { key: string; pre?: string; post?: string }[] = [
  { key: "unpackPhase", pre: "preUnpack", post: "postUnpack" },
  { key: "patchPhase", pre: "prePatch", post: "postPatch" },
  { key: "configurePhase", pre: "preConfigure", post: "postConfigure" },
  { key: "buildPhase", pre: "preBuild", post: "postBuild" },
  { key: "checkPhase", pre: "preCheck", post: "postCheck" },
  { key: "installPhase", pre: "preInstall", post: "postInstall" },
  { key: "fixupPhase", pre: "preFixup", post: "postFixup" },
  { key: "installCheckPhase", pre: "preInstallCheck", post: "postInstallCheck" },
  { key: "buildCommand" },
]

function phasesFromEnv(env: Record<string, string>): DrvPhase[] {
  const phases: DrvPhase[] = []
  const pushIfPresent = (name: string) => {
    const script = env[name]
    if (typeof script === "string" && script.length > 0) {
      phases.push({
        name,
        script: script.length > PHASE_CAP ? `${script.slice(0, PHASE_CAP)}\n… truncated` : script,
      })
    }
  }
  for (const p of PHASE_ORDER) {
    if (p.pre) pushIfPresent(p.pre)
    pushIfPresent(p.key)
    if (p.post) pushIfPresent(p.post)
  }
  return phases
}

const DRV_BASENAME_RE = /^[a-z0-9]{32}-(.+)\.drv$/

function nameFromDrvBasename(basename: string): string {
  const m = basename.match(DRV_BASENAME_RE)
  return m ? m[1]! : basename.replace(/\.drv$/, "")
}

/**
 * `nix derivation show` returns bare store-path BASENAMES (no "/nix/store/"
 * prefix) as both its top-level key and each output's `path` — verified
 * against a running nix, not assumed. Newer nix wraps the whole result in
 * {"derivations": {...}}; older nix returns the drv map directly at the top
 * level. Newer nix also nests input drvs under `inputs.drvs`; older nix may
 * put them directly at `inputDrvs`. Both dimensions normalized here.
 */
export function normalizeDerivationShow(raw: unknown): DrvInfo | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const container = (
    r.derivations && typeof r.derivations === "object" ? r.derivations : raw
  ) as Record<string, unknown>
  const entries = Object.entries(container)
  if (entries.length === 0) return null
  const [basename, rawEntry] = entries[0]!
  if (!rawEntry || typeof rawEntry !== "object") return null
  const e = rawEntry as Record<string, unknown>

  const nestedDrvs = (e.inputs as { drvs?: Record<string, { outputs?: string[] }> } | undefined)?.drvs
  const flatDrvs = e.inputDrvs as Record<string, { outputs?: string[] }> | undefined
  const rawInputDrvs = nestedDrvs ?? flatDrvs ?? {}
  const inputDrvs: DrvInputRef[] = Object.entries(rawInputDrvs).map(([drvBasename, info]) => ({
    drvPath: `/nix/store/${drvBasename}`,
    name: nameFromDrvBasename(drvBasename),
    outputs: info.outputs ?? [],
  }))

  const env = (typeof e.env === "object" && e.env !== null ? e.env : {}) as Record<string, string>

  return {
    drvPath: `/nix/store/${basename}`,
    system: typeof e.system === "string" ? e.system : "",
    builderPath: typeof e.builder === "string" ? e.builder : "",
    inputDrvs,
    phases: phasesFromEnv(env),
    doCheck: "doCheck" in env ? env.doCheck === "1" : undefined,
    strictDeps: "strictDeps" in env ? env.strictDeps === "1" : undefined,
    structuredAttrs: "__structuredAttrs" in env ? env.__structuredAttrs === "1" : undefined,
  }
}

// -------------------------------------------------------- normalizePackageMeta

const MAX_MAINTAINERS = 20
const MAX_PLATFORMS = 64

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined
}

function normalizeLicense(v: unknown): PackageLicense[] {
  if (v == null) return []
  if (typeof v === "string") return [{ shortName: v }]
  if (Array.isArray(v)) return v.flatMap(normalizeLicense)
  if (typeof v === "object") {
    const o = v as Record<string, unknown>
    return [
      {
        shortName: asString(o.shortName),
        fullName: asString(o.fullName),
        spdxId: asString(o.spdxId),
        url: asString(o.url),
        free: typeof o.free === "boolean" ? o.free : undefined,
      },
    ]
  }
  return []
}

function normalizeMaintainers(v: unknown): PackageMaintainer[] {
  if (!Array.isArray(v)) return []
  return v.slice(0, MAX_MAINTAINERS).map((m) => {
    const o = (typeof m === "object" && m !== null ? m : {}) as Record<string, unknown>
    return { name: asString(o.name), github: asString(o.github), email: asString(o.email) }
  })
}

/**
 * Shapes extract.nix's raw scrubbed `meta` attrset into PackageMeta —
 * license normalization (nixpkgs meta.license is a string, a single license
 * attrset, or a list of either) happens here rather than in Nix: extract.nix
 * only needs to get the whole meta object safely out via scrub+deepSafe
 * (a throw anywhere in meta, e.g. an unfree/broken marker, must not poison
 * the rest of the package), so shape interpretation is left to this
 * pure/unit-tested function.
 */
export function normalizePackageMeta(raw: Record<string, unknown>): PackageMeta {
  const license = normalizeLicense(raw.license)
  const maintainers = normalizeMaintainers(raw.maintainers)
  const platforms = Array.isArray(raw.platforms)
    ? raw.platforms.filter((p): p is string => typeof p === "string").slice(0, MAX_PLATFORMS)
    : undefined
  return {
    description: asString(raw.description),
    homepage: asString(raw.homepage),
    license: license.length > 0 ? license : undefined,
    platforms: platforms && platforms.length > 0 ? platforms : undefined,
    mainProgram: asString(raw.mainProgram),
    maintainers: maintainers.length > 0 ? maintainers : undefined,
    position: asString(raw.position),
    broken: typeof raw.broken === "boolean" ? raw.broken : undefined,
    unfree: typeof raw.unfree === "boolean" ? raw.unfree : undefined,
  }
}
