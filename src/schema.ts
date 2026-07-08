// JSON data contract between the extraction CLI (src/extract/*) and the SPA
// (app/*). Two documents: a cheap Manifest (always regenerated) and one
// expensive ConfigData blob per nixos/darwin configuration (extracted on
// demand). storePath is the universal join key: FileEntry.storePath matches
// the file strings in OptionEntry declarations/definitions.

export const SCHEMA_VERSION = 1;

/** Extractor version — part of the cache key; bump on schema/extractor changes. */
export const EXTRACTOR_VERSION = "0.1.0";

export interface Manifest {
  version: typeof SCHEMA_VERSION;
  generatedAt: string; // ISO timestamp
  extractor: string; // EXTRACTOR_VERSION at generation time
  flake: FlakeInfo;
  /** Output tree from `nix flake show --json`, normalized. */
  outputs: OutputNode;
  /** Root-level inputs, keyed by input name. */
  inputs: Record<string, InputInfo>;
  files: FileEntry[];
  /** file→file static import graph (self files only). */
  importEdges: ImportEdge[];
  configurations: ConfigRef[];
  /** Discovered import-tree roots relative to the flake root, e.g. ["modules"]. */
  moduleDirs: string[];
  /** Outputs that extend an input's same-named namespace (lib = nixpkgs.lib.extend …). */
  grafts: GraftInfo[];
  /** Top-level attr names per output — fills in where nix flake show says "unknown". */
  outputNames: Record<string, string[]>;
  /** Non-fatal extraction problems, surfaced in the UI. */
  warnings: string[];
}

/**
 * A top-level output detected as a graft onto an input's same-named
 * namespace: ≥90% of the input's attr names reappear in the output. The UI
 * shows only `added` and hides the inherited bulk.
 */
export interface GraftInfo {
  /** Top-level output name, e.g. "lib". */
  output: string;
  /** Direct input whose namespace it extends, e.g. "nixpkgs". */
  input: string;
  /** Keys the flake adds on top of the input's namespace. */
  added: string[];
  /** Count of keys inherited (by name) from the input. */
  inherited: number;
}

export interface FlakeInfo {
  /** Flake reference as given on the CLI. */
  ref: string;
  /** self.outPath — the flake's own store path. */
  path: string;
  /** Real directory when the flakeref is path-like (enables git lookups). */
  localCheckout?: string;
  description?: string;
  rev?: string;
  narHash?: string;
  lastModified?: number;
}

export type OutputNode =
  | { kind: "attrset"; children: Record<string, OutputNode> }
  | { kind: "leaf"; type: string; name?: string; description?: string }
  /** `nix flake show` omitted this (other-system or eval failure). */
  | { kind: "omitted" }
  /** `nix flake show` could not classify it ({"unknown": true}). */
  | { kind: "unknown" };

export interface InputInfo {
  /**
   * Display name: the input attr for direct inputs, "parent/child" for
   * transitive ones (deduped — a followed input appears once).
   */
  name: string;
  /** flake.lock node key (differs from name for deduped/followed nodes). */
  nodeKey: string;
  /** Present on inputs-of-inputs; the UI legend shows direct inputs only. */
  transitive?: true;
  type: string;
  url?: string;
  ref?: string;
  rev?: string;
  narHash?: string;
  lastModified?: number;
  /** toString inputs.<name>.outPath — prefix-match key for file attribution. */
  storePath?: string;
  /** Present when this input follows another (value = followed node key). */
  follows?: string;
}

export type FileOrigin =
  | { kind: "self" }
  /** patched: the file lives in a patched COPY of the input's source tree. */
  | { kind: "input"; input: string; patched?: true }
  /** group: display bucket for unattributed store roots ("source@abc1234"). */
  | { kind: "unknown"; group?: string };

export interface FileEntry {
  /** Stable id: "self:modules/hosts/nebula.nix" | "input:darwin:modules/x.nix". */
  id: string;
  /** Path relative to its origin root. */
  relPath: string;
  origin: FileOrigin;
  /** Absolute /nix/store/... path — JOIN KEY to option file references. */
  storePath: string;
  /** Last commit touching this file; self files with a local checkout only. */
  git?: { commit: string; date: string; subject: string };
}

// ---------------------------------------------------------------------------
// GET /data/file/<id> response (src/extract/highlight.ts tokenizes server-side)

export interface FileSource {
  text: string;
  /** Flat, non-overlapping tree-sitter highlight spans over `text`; [] if tokenizing failed. */
  tokens: TokenRun[];
}

export interface TokenRun {
  start: number;
  end: number;
  /** Highlight-query capture name, e.g. "keyword", "string", "string.special.path". */
  name: string;
}

/** Directed edge: `from` imports `to` (both FileEntry.id). */
export interface ImportEdge {
  from: string;
  to: string;
}

export type ConfigKind = "nixos" | "darwin";

export interface ConfigRef {
  /** "nixos/nebula", "darwin/k". */
  id: string;
  kind: ConfigKind;
  name: string;
  /** Data file relative to the data dir, e.g. "config/nixos.nebula.json". */
  dataFile: string;
  status: "pending" | "ok" | "error";
  error?: string;
  extractedAt?: string;
  optionCount?: number;
  durationMs?: number;
}

// ---------------------------------------------------------------------------
// Per-configuration blob (data/config/<kind>.<name>.json)

export interface ConfigData {
  id: string;
  options: OptionEntry[];
  /**
   * storePath (or "<unknown-file>") -> indices into `options`, split by role.
   * Precomputed so the SPA never scans thousands of options per click:
   * `defines` = files that set a value, `declares` = files declaring the option.
   */
  fileIndex: Record<string, FileOptionRefs>;
}

export interface FileOptionRefs {
  defines: number[];
  declares: number[];
}

/** Well-known mk-priority values (lib.mkOverride n). */
export const PRIO = {
  mkForce: 50,
  plain: 100,
  mkDefault: 1000,
  /** The option's own declared default (lib.mkOptionDefault). */
  optionDefault: 1500,
} as const;

export interface OptionEntry {
  /** Option path, e.g. ["services", "nginx", "enable"]. */
  loc: string[];
  /** type.description, e.g. "boolean" or "string matching ...". */
  type?: string;
  description?: string;
  internal: boolean;
  visible: boolean;
  readOnly: boolean;
  isDefined: boolean;
  /** Winning definition priority; absent when !isDefined. */
  highestPrio?: number;
  /** isDefined && highestPrio < 1500 — a real definition beat the default. */
  customized: boolean;
  /** Merged value (scrubbed); absent for package-typed or throwing values. */
  value?: unknown;
  /** True when evaluating/serializing the value threw. */
  valueError?: true;
  default?: unknown;
  defaultText?: string;
  /** Declaring files, merged with declarationPositions when available. */
  declarations: DeclarationRef[];
  /** One entry per definition (options.<x>.definitionsWithLocations). */
  definitions: DefinitionRef[];
}

export interface DeclarationRef {
  file: string; // store path or "<unknown-file>"
  line?: number;
  column?: number;
}

export interface DefinitionRef {
  file: string; // store path or "<unknown-file>"
  /** Module-system provenance, e.g. "configurations.nixos.nebula.module". */
  via?: string;
  value?: unknown;
  valueError?: true;
}

/** Sentinel file string the module system uses for inline/anonymous modules. */
export const UNKNOWN_FILE = "<unknown-file>";
