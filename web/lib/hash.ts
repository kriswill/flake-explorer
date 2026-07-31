// URL-hash codec for explorer state (okflight pattern: selection is the
// path segment, view filters ride behind `?`). Selection changes push
// history entries; filter-only changes replaceState — Back walks selections
// without replaying every keystroke.
//
// Forms:
//   #/o/<output.path.dots>            outputs-tree selection (non-module)
//   #/c/<configId>                    configuration selection
//   #/c/<configId>/m/<moduleId>       module within a configuration
//   #/c/<configId>/opt/<loc.dots>     option within a configuration
//   #/f/<fileId>                      file selection
//   #/i/<inputName>                   flake input selection
//   #/diff/<configA>/<configB>        two-configuration option diff
//   #/g/<graphId>                     dependency-graph selection
//   #/g/<graphId>/n/<drvBasename>     a node within that graph
//
// The graph node segment is the derivation's store BASENAME, never its index:
// nodes are sorted by drvPath, so inserting one shifts every later index and a
// shared link would silently point at a different derivation after a rebuild.
// Basenames are measured unique within every real document (18,765/18,765 on a
// system graph) because the nix hash is their prefix. It is a SINGLE segment,
// not a dot-joined one — every basename ends ".drv", so a dot-joined form
// would shatter all of them.
// filters: ?q=<search>&all=1 (option filter "all" instead of "customized")
//          &L=<line> (scroll the source view to a line; replace-state like
//          the other filters — Back walks selections, not line jumps)
//          &contrib=1 (file list shows only files a loaded config uses)

export type Selection =
  | { kind: "output"; path: string[] }
  | { kind: "config"; configId: string }
  | { kind: "module"; configId: string; moduleId: string }
  | { kind: "option"; configId: string; loc: string[] }
  | { kind: "file"; fileId: string }
  | { kind: "input"; name: string }
  | { kind: "diff"; a: string; b: string }
  | { kind: "graph"; graphId: string }
  | { kind: "graphNode"; graphId: string; drvBase: string }

export interface Filters {
  q: string
  /** Show all options in the detail panel, not just customized ones. */
  all: boolean
  /** 1-based source line to scroll to (file/module source views). */
  line: number | null
  /** Restrict the file list to files that contribute to a loaded configuration. */
  contrib: boolean
}

export interface ViewState {
  sel: Selection | null
  filters: Filters
}

// '%' breaks the decode round-trip; '?' reads as the filter separator; '/'
// would split ids. Escape all three (ids and paths may contain them).
const enc = (s: string) => s.replace(/%/g, "%25").replace(/\?/g, "%3F").replace(/\//g, "%2F")

function encodeSel(sel: Selection | null): string {
  if (!sel) return ""
  switch (sel.kind) {
    case "output":
      // '.' is the output-path separator, so escape it per-segment (quoted Nix
      // attrs may contain dots); other kinds keep readable dots ("flake.nix").
      return `/o/${sel.path.map((s) => enc(s).replace(/\./g, "%2E")).join(".")}`
    case "config":
      return `/c/${enc(sel.configId)}`
    case "module":
      return `/c/${enc(sel.configId)}/m/${enc(sel.moduleId)}`
    case "option":
      // '.' separates loc segments (same per-segment escaping as "output":
      // quoted Nix attrs may contain dots).
      return `/c/${enc(sel.configId)}/opt/${sel.loc.map((s) => enc(s).replace(/\./g, "%2E")).join(".")}`
    case "file":
      return `/f/${enc(sel.fileId)}`
    case "input":
      return `/i/${enc(sel.name)}`
    case "diff":
      return `/diff/${enc(sel.a)}/${enc(sel.b)}`
    case "graph":
      return `/g/${enc(sel.graphId)}`
    case "graphNode":
      // enc() escapes the '?' that 66 real basenames carry; without it the
      // decoder would read the rest of the basename as the filter query.
      return `/g/${enc(sel.graphId)}/n/${enc(sel.drvBase)}`
  }
}

export function encodeHash(view: ViewState): string {
  const p = new URLSearchParams()
  if (view.filters.q) p.set("q", view.filters.q)
  if (view.filters.all) p.set("all", "1")
  if (view.filters.line) p.set("L", String(view.filters.line))
  if (view.filters.contrib) p.set("contrib", "1")
  const qs = p.toString()
  return encodeSel(view.sel) + (qs ? `?${qs}` : "")
}

export function decodeHash(raw: string): ViewState {
  const bare = raw.replace(/^#/, "")
  const qi = bare.indexOf("?")
  const selPart = qi < 0 ? bare : bare.slice(0, qi)
  const p = new URLSearchParams(qi >= 0 ? bare.slice(qi + 1) : "")
  const lineRaw = p.get("L")
  const line = lineRaw && /^\d+$/.test(lineRaw) ? Number(lineRaw) : null
  return {
    sel: decodeSel(selPart),
    filters: {
      q: p.get("q") ?? "",
      all: p.get("all") === "1",
      line: line || null,
      contrib: p.get("contrib") === "1",
    },
  }
}

function seg(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s // stray '%' in a hand-edited link
  }
}

function decodeSel(path: string): Selection | null {
  const parts = path.split("/").filter(Boolean)
  if (parts.length === 0) return null
  const [tag, a, tag2, b] = parts
  // Single-id remainder: everything after the tag, rejoined. The app's own
  // encoder escapes '/' as %2F so its links land in `a` alone; a hand-typed
  // link (#/f/self:pkgs/rtk.nix) keeps the slash raw and splits across parts.
  // Rejoining then decoding converges both forms — seg() turns %2F and a raw
  // '/' into the same id — instead of truncating to a non-existent `a`.
  const rest = () => seg(parts.slice(1).join("/"))
  if (tag === "g" && a) {
    // Find the 'n' marker from the RIGHT. A graph id contains '/' (which the
    // encoder escapes, but a hand-typed link may not) and one of its own
    // segments could legitimately be "n" — scanning from the right cannot
    // mistake that for the marker, where scanning from the left would.
    const m = parts.lastIndexOf("n")
    if (m > 0 && m < parts.length - 1)
      return {
        kind: "graphNode",
        graphId: seg(parts.slice(1, m).join("/")),
        drvBase: seg(parts.slice(m + 1).join("/")),
      }
    // An 'n' with nothing after it is a truncated link, not a broken node
    // route: fall back to the graph itself rather than inventing a node.
    const idParts = m > 0 ? parts.slice(1, m) : parts.slice(1)
    return { kind: "graph", graphId: seg(idParts.join("/")) }
  }
  if (tag === "diff" && a && tag2) return { kind: "diff", a: seg(a), b: seg(tag2) }
  if (tag === "o" && a) return { kind: "output", path: a.split(".").map(seg).filter(Boolean) }
  if (tag === "c" && a && tag2 === "m" && b)
    return { kind: "module", configId: seg(a), moduleId: seg(b) }
  if (tag === "c" && a && tag2 === "opt" && b)
    return { kind: "option", configId: seg(a), loc: b.split(".").map(seg).filter(Boolean) }
  // Multi-arg config routes (m/opt) are handled above and keep '/' as a real
  // separator; a bare config id falls through to the single-id rejoin.
  if (tag === "c" && a) return { kind: "config", configId: rest() }
  if (tag === "f" && a) return { kind: "file", fileId: rest() }
  if (tag === "i" && a) return { kind: "input", name: rest() }
  return null
}

/** Same selection => filter-only change => replaceState instead of push. */
export function sameSelection(a: Selection | null, b: Selection | null): boolean {
  if (a === b) return true
  if (!a || !b || a.kind !== b.kind) return false
  return encodeSel(a) === encodeSel(b)
}
