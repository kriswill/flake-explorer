// JSON data contract between the extraction CLI (src/extract/*) and the SPA
// (app/*). Two documents: a cheap Manifest (always regenerated) and one
// expensive ConfigData blob per nixos/darwin configuration (extracted on
// demand). storePath is the universal join key: FileEntry.storePath matches
// the file strings in OptionEntry declarations/definitions.

export const SCHEMA_VERSION = 1

export interface Manifest {
  version: typeof SCHEMA_VERSION
  generatedAt: string // ISO timestamp
  extractor: string // extraction-code fingerprint at generation time (extract/fingerprint.ts)
  flake: FlakeInfo
  /** Output tree from `nix flake show --json`, normalized. */
  outputs: OutputNode
  /** Root-level inputs, keyed by input name. */
  inputs: Record<string, InputInfo>
  files: FileEntry[]
  /** file→file static import graph (self files only). */
  importEdges: ImportEdge[]
  /** Self files whose source references `inputs.<name>` (regex scan, like importEdges). */
  inputRefs: InputRef[]
  /** Self files whose source defines `overlays.<name>` (regex scan, like inputRefs). */
  overlayDefs?: OverlayDef[]
  /** Follows/shared-node edges dropped from `inputs` by dedup (see InputFollow). */
  inputFollows: InputFollow[]
  configurations: ConfigRef[]
  /** Derivation-typed outputs: packages, devShells, checks, formatter (see PackageRef). */
  packages: PackageRef[]
  /**
   * "What in this flake depends on X": depended-on package refId -> dependent
   * refIds. Present only in a static export (built from the embedded package
   * blobs — see extract/reverse-deps.ts); authoritative over the EXPORTED set,
   * which a partial `--packages` export makes partial. Absent in serve mode,
   * where the manifest carries no package data — the SPA then derives a
   * client-side index over loaded packages, labeled honestly.
   */
  packageReverseDeps?: Record<string, string[]>
  /** Outputs that extend an input's same-named namespace (lib = nixpkgs.lib.extend …). */
  grafts: GraftInfo[]
  /** Top-level attr names per output — fills in where nix flake show says "unknown". */
  outputNames: Record<string, string[]>
  /** Non-fatal extraction problems, surfaced in the UI. */
  warnings: string[]
}

/**
 * A top-level output detected as a graft onto an input's same-named
 * namespace: ≥90% of the input's attr names reappear in the output. The UI
 * shows only `added` and hides the inherited bulk.
 */
export interface GraftInfo {
  /** Top-level output name, e.g. "lib". */
  output: string
  /** Direct input whose namespace it extends, e.g. "nixpkgs". */
  input: string
  /** Keys the flake adds on top of the input's namespace. */
  added: string[]
  /** Count of keys inherited (by name) from the input. */
  inherited: number
}

export interface FlakeInfo {
  /** Flake reference as given on the CLI. */
  ref: string
  /** self.outPath — the flake's own store path. */
  path: string
  description?: string
  rev?: string
  narHash?: string
}

export type OutputNode =
  | { kind: "attrset"; children: Record<string, OutputNode> }
  | { kind: "leaf"; type: string; name?: string; description?: string }
  /** `nix flake show` omitted this (other-system or eval failure). */
  | { kind: "omitted" }
  /** `nix flake show` could not classify it ({"unknown": true}). */
  | { kind: "unknown" }

export interface InputInfo {
  /**
   * Display name: the input attr for direct inputs, "parent/child" for
   * transitive ones (deduped — a followed input appears once).
   */
  name: string
  /**
   * flake.lock node key (differs from name for deduped/followed nodes).
   * Not rendered directly, but it is the join target `follows` points at.
   */
  nodeKey: string
  /** Present on inputs-of-inputs; the UI legend shows direct inputs only. */
  transitive?: true
  /**
   * Other ROOT-level input names that follow this same lock node (e.g.
   * "stable" for `inputs.stable.follows = "nixpkgs"`). The entry keeps the
   * real (non-follows) input's name; aliases are sorted for determinism.
   */
  aliases?: string[]
  type: string
  url?: string
  ref?: string
  rev?: string
  narHash?: string
  lastModified?: number
  /** toString inputs.<name>.outPath — prefix-match key for file attribution. */
  storePath?: string
  /** Present when this input follows another (value = followed node key). */
  follows?: string
}

export type FileOrigin =
  | { kind: "self" }
  /** patched: the file lives in a patched COPY of the input's source tree. */
  | { kind: "input"; input: string; patched?: true }
  /** group: display bucket for unattributed store roots ("source@abc1234"). */
  | { kind: "unknown"; group?: string }

/**
 * FileEntry.id codec. The format ("self:<rel>" | "input:<name>:<rel>") is a
 * client-server protocol — serve's /data/file/<id> route re-derives input
 * files from the id — so every construction and parse site goes through
 * these helpers. (resolveFile's "unknown:…"/"inline" buckets are app-internal
 * and opaque: parseFileId returns null for them.)
 */
export function makeFileId(
  origin: { kind: "self" } | { kind: "input"; input: string },
  relPath: string,
): string {
  return origin.kind === "self" ? `self:${relPath}` : `input:${origin.input}:${relPath}`
}

export type ParsedFileId =
  | { kind: "self"; relPath: string }
  | { kind: "input"; input: string; relPath: string }

export function parseFileId(id: string): ParsedFileId | null {
  if (id.startsWith("self:")) return { kind: "self", relPath: id.slice(5) }
  const m = id.match(/^input:([^:]+):(.+)$/)
  return m ? { kind: "input", input: m[1]!, relPath: m[2]! } : null
}

/** Display label for a file id: its relPath; opaque (unknown-bucket) ids as-is. */
export function displayLabel(id: string): string {
  return parseFileId(id)?.relPath ?? id
}

export interface FileEntry {
  /** Stable id — see makeFileId/parseFileId above. */
  id: string
  /** Path relative to its origin root. */
  relPath: string
  origin: FileOrigin
  /** Absolute /nix/store/... path — JOIN KEY to option file references. */
  storePath: string
  /** Last commit touching this file; self files with a local checkout only. */
  git?: { commit: string; date: string; subject: string }
}

// ---------------------------------------------------------------------------
// GET /data/file/<id> response (src/extract/highlight.ts tokenizes server-side)

export interface FileSource {
  text: string
  /** Flat, non-overlapping tree-sitter highlight spans over `text`; [] if tokenizing failed. */
  tokens: TokenRun[]
}

export interface TokenRun {
  start: number
  end: number
  /** Highlight-query capture name, e.g. "keyword", "string", "string.special.path". */
  name: string
}

/** Directed edge: `from` imports `to` (both FileEntry.id). */
export interface ImportEdge {
  from: string
  to: string
}

/** A self file whose source text references `inputs.<input>` (or `inputs'.<input>`). */
export interface InputRef {
  /** FileEntry.id of the referencing file. */
  file: string
  /** Canonical root input name (follows aliases resolved to the real input). */
  input: string
}

/**
 * A self file whose source text defines `overlays.<name>` (or flake-parts'
 * `flake.overlays.<name>`). The only defining-file signal available for
 * overlays: `nix flake show` reports no position and the extractor never
 * evaluates overlay bodies.
 */
export interface OverlayDef {
  /** Overlay attr name, e.g. "default". */
  name: string
  /** FileEntry.id of the defining file. */
  file: string
  /**
   * Top-level attrs the overlay body adds/overrides, when the body could be
   * located and its `final: prev: { … }` form scanned. Absent for overlays
   * whose body can't be scanned syntactically (anonymous list overlays,
   * computed attr names) — a documented limit, not an empty overlay.
   */
  attrs?: OverlayAttr[]
}

/** One top-level attr an overlay body defines. `override` = its rhs patches the
 *  prior package (references `prev.`/`super.` or uses `.override`/`.overrideAttrs`). */
export interface OverlayAttr {
  name: string
  kind: "add" | "override"
}

/**
 * A transitive lock-graph edge whose target node is already claimed by
 * another inputs entry (follows dedup): the "sops-nix/nixpkgs → nixpkgs"
 * arrows. Without these the deduped inputs record silently drops exactly
 * the follows relationships people get lost in.
 */
export interface InputFollow {
  /** "parent/child" name the edge would have had as its own entry. */
  name: string
  /** Name of the InputInfo entry that owns the shared lock node. */
  target: string
}

export type ConfigKind = "nixos" | "darwin"

export interface ConfigRef {
  /** "nixos/nebula", "darwin/k". */
  id: string
  kind: ConfigKind
  name: string
  /** Data file relative to the data dir, e.g. "config/nixos.nebula.json". */
  dataFile: string
  status: "pending" | "ok" | "error"
  error?: string
  extractedAt?: string
  optionCount?: number
  durationMs?: number
}

// ---------------------------------------------------------------------------
// Derivation-typed outputs: packages, devShells, checks, formatter. Extracted
// on demand (data/package/<safe-path>.json), same lifecycle as ConfigRef —
// enumerated for free from the already-normalized `outputs` tree (no extra
// eval), unlike ConfigRef which comes from a dedicated nix-side eval.

export interface PackageRef {
  /** path.join("/"), e.g. "packages/x86_64-linux/rtk". */
  id: string
  /** Output-tree path segments, e.g. ["packages", "x86_64-linux", "rtk"]. */
  path: string[]
  /** Data file relative to the data dir, e.g. "package/packages.x86_64-linux.rtk.json". */
  dataFile: string
  status: "pending" | "ok" | "error"
  error?: string
  extractedAt?: string
  durationMs?: number
}

export type BuilderKind =
  | "rustPlatform"
  | "buildGoModule"
  | "node"
  | "trivial"
  | "stdenv"
  | "unknown"

export interface PackageLicense {
  shortName?: string
  fullName?: string
  spdxId?: string
  url?: string
  free?: boolean
}

export interface PackageMaintainer {
  name?: string
  github?: string
  email?: string
}

export interface PackageMeta {
  description?: string
  homepage?: string
  /** Always normalized to a list, whatever shape meta.license took (attr/list/string). */
  license?: PackageLicense[]
  platforms?: string[]
  mainProgram?: string
  /** Capped — some nixpkgs packages list dozens. */
  maintainers?: PackageMaintainer[]
  /** meta.position, "file:line" — resolvable to a file chip when under the flake's own path. */
  position?: string
  broken?: boolean
  unfree?: boolean
}

export interface PackageSrc {
  storePath?: string
  url?: string
  rev?: string
  outputHash?: string
}

export interface PackageDeps {
  nativeBuildInputs: string[]
  buildInputs: string[]
  propagatedBuildInputs: string[]
}

/** One derivation phase script, e.g. {name: "buildPhase", script: "..."}. */
export interface DrvPhase {
  name: string
  script: string
  /** Flat, non-overlapping tree-sitter (bash) highlight spans over `script`; [] if tokenizing failed. */
  tokens: TokenRun[]
}

export interface DrvInputRef {
  drvPath: string
  name: string
  outputs: string[]
}

/**
 * `nix derivation show` output (instantiation only — never builds). Absent
 * when instantiation itself fails (recorded as a warning instead).
 */
export interface DrvInfo {
  drvPath: string
  system: string
  builderPath: string
  inputDrvs: DrvInputRef[]
  /** Scripts capped ~4000 chars each. */
  phases: DrvPhase[]
  doCheck?: boolean
  strictDeps?: boolean
  structuredAttrs?: boolean
}

/**
 * `nix path-info` for one output — present only when that output's path is
 * already valid in the local store (query-only; this tool never builds).
 */
export interface RuntimeInfo {
  outPath: string
  references: string[]
  narSize?: number
  closureSize?: number
}

// ---------------------------------------------------------------------------
// Per-package blob (data/package/<safe-path>.json)

export interface PackageData {
  /** SCHEMA_VERSION at extraction time — the SPA rejects mismatched blobs. */
  version: typeof SCHEMA_VERSION
  id: string
  path: string[]
  name?: string
  pname?: string
  /**
   * The derivation's own `version` attr — named pkgVersion (not `version`)
   * to avoid colliding with the schema-version discriminant above.
   */
  pkgVersion?: string
  builder: BuilderKind
  stdenv?: string
  system?: string
  meta?: PackageMeta
  src?: PackageSrc
  outputs: { name: string; outPath?: string }[]
  deps: PackageDeps
  drv?: DrvInfo
  /** Keyed by output name, e.g. runtime.out. */
  runtime?: Record<string, RuntimeInfo>
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Per-configuration blob (data/config/<kind>.<name>.json)

export interface ConfigData {
  /** SCHEMA_VERSION at extraction time — the SPA rejects mismatched blobs. */
  version: typeof SCHEMA_VERSION
  id: string
  options: OptionEntry[]
  /**
   * storePath (or "<unknown-file>") -> indices into `options`, split by role.
   * Precomputed so the SPA never scans thousands of options per click:
   * `defines` = files that set a value, `declares` = files declaring the option.
   */
  fileIndex: Record<string, FileOptionRefs>
}

export interface FileOptionRefs {
  defines: number[]
  declares: number[]
}

/** Well-known mk-priority values (lib.mkOverride n). */
export const PRIO = {
  mkForce: 50,
  plain: 100,
  mkDefault: 1000,
  /** The option's own declared default (lib.mkOptionDefault). */
  optionDefault: 1500,
} as const

export interface OptionEntry {
  /** Option path, e.g. ["services", "nginx", "enable"]. */
  loc: string[]
  /** type.description, e.g. "boolean" or "string matching ...". */
  type?: string
  description?: string
  readOnly: boolean
  isDefined: boolean
  /** Winning definition priority; absent when !isDefined. */
  highestPrio?: number
  /** isDefined && highestPrio < 1500 — a real definition beat the default. */
  customized: boolean
  /** Merged value (scrubbed); absent for package-typed or throwing values. */
  value?: unknown
  /** True when evaluating/serializing the value threw. */
  valueError?: true
  /** True when the extractor skipped the value (package-typed, or a degraded chunk). */
  valueSkipped?: true
  /**
   * Derivation names found in a package-typed value whose full value was
   * skipped (valueSkipped stays true so older UIs degrade honestly). Only
   * `.name`/`.pname` are forced per element — never the closure.
   */
  valueNames?: string[]
  default?: unknown
  /** Like valueNames, for a skipped package-typed default. */
  defaultNames?: string[]
  defaultText?: string
  /** Declaring files. */
  declarations: DeclarationRef[]
  /** One entry per definition (options.<x>.definitionsWithLocations). */
  definitions: DefinitionRef[]
}

export interface DeclarationRef {
  file: string // store path or "<unknown-file>"
  /** 1-based declaration site (option.declarationPositions); absent on older module systems. */
  line?: number
  column?: number
  /**
   * Module-system provenance: the file was imported "via option <path>"
   * (e.g. "flake.modules.nixos.desktop" for dendritic flake-parts modules).
   * Lifted from the ", via option …" suffix the module system stamps onto
   * file strings; `file` is always the clean store path.
   */
  via?: string
}

export interface DefinitionRef {
  file: string // store path or "<unknown-file>"
  value?: unknown
  valueError?: true
  /** True when the extractor skipped this definition's value. */
  valueSkipped?: true
  /** Like OptionEntry.valueNames, for this definition's skipped package-typed value. */
  valueNames?: string[]
  /** See DeclarationRef.via. */
  via?: string
  /**
   * mkOverride priority lifted from a wrapper surviving in this definition's
   * raw value. The real module system strips wrappers AND drops losing-prio
   * definitions before exposing definitionsWithLocations (lib filterOverrides),
   * so there absent means "merged at the option's highestPrio"; it is present
   * only on module systems that expose raw definition values.
   */
  prio?: number
}

/** Sentinel file string the module system uses for inline/anonymous modules. */
export const UNKNOWN_FILE = "<unknown-file>"

// ---------------------------------------------------------------------------
// Runtime shape guards for the SPA's ingestion points.
//
// Everything above is compile-time only: the SPA reaches these documents
// through `JSON.parse(...) as T`, so a blob from an interrupted extractor (or
// a hand-edited one) that still carries the right `version` sails past the
// version gate and only fails later, deep inside index-building, as a raw
// TypeError about something undefined. These check exactly what the index
// builders and renderers go on to dereference — no more, so a forward-
// compatible blob carrying extra fields still loads.

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

export function isManifest(v: unknown): v is Manifest {
  return (
    isObj(v) &&
    v.version === SCHEMA_VERSION &&
    isObj(v.flake) &&
    typeof v.flake.path === "string" &&
    Array.isArray(v.files) &&
    Array.isArray(v.configurations) &&
    Array.isArray(v.packages) &&
    isObj(v.inputs) &&
    isObj(v.outputs)
  )
}

export function isConfigData(v: unknown): v is ConfigData {
  return isObj(v) && v.version === SCHEMA_VERSION && Array.isArray(v.options) && isObj(v.fileIndex)
}

export function isPackageData(v: unknown): v is PackageData {
  return isObj(v) && v.version === SCHEMA_VERSION && Array.isArray(v.outputs) && isObj(v.deps)
}
