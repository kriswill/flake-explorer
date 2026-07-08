// URL-hash codec for explorer state (okflight pattern: selection is the
// path segment, view filters ride behind `?`). Selection changes push
// history entries; filter-only changes replaceState — Back walks selections
// without replaying every keystroke.
//
// Forms:
//   #/o/<output.path.dots>            outputs-tree selection (non-module)
//   #/c/<configId>                    configuration selection
//   #/c/<configId>/m/<moduleId>       module within a configuration
//   #/f/<fileId>                      file selection
//   #/i/<inputName>                   flake input selection
// filters: ?q=<search>&all=1 (option filter "all" instead of "customized")

export type Selection =
  | { kind: "output"; path: string[] }
  | { kind: "config"; configId: string }
  | { kind: "module"; configId: string; moduleId: string }
  | { kind: "file"; fileId: string }
  | { kind: "input"; name: string };

export interface Filters {
  q: string;
  /** Show all options in the detail panel, not just customized ones. */
  all: boolean;
}

export interface ViewState {
  sel: Selection | null;
  filters: Filters;
}

// '%' breaks the decode round-trip; '?' reads as the filter separator; '/'
// would split ids. Escape all three (ids and paths may contain them).
const enc = (s: string) => s.replace(/%/g, "%25").replace(/\?/g, "%3F").replace(/\//g, "%2F");

function encodeSel(sel: Selection | null): string {
  if (!sel) return "";
  switch (sel.kind) {
    case "output":
      return "/o/" + sel.path.map(enc).join(".");
    case "config":
      return "/c/" + enc(sel.configId);
    case "module":
      return "/c/" + enc(sel.configId) + "/m/" + enc(sel.moduleId);
    case "file":
      return "/f/" + enc(sel.fileId);
    case "input":
      return "/i/" + enc(sel.name);
  }
}

export function encodeHash(view: ViewState): string {
  const p = new URLSearchParams();
  if (view.filters.q) p.set("q", view.filters.q);
  if (view.filters.all) p.set("all", "1");
  const qs = p.toString();
  return encodeSel(view.sel) + (qs ? "?" + qs : "");
}

export function decodeHash(raw: string): ViewState {
  const bare = raw.replace(/^#/, "");
  const qi = bare.indexOf("?");
  const selPart = qi < 0 ? bare : bare.slice(0, qi);
  const p = new URLSearchParams(qi >= 0 ? bare.slice(qi + 1) : "");
  return {
    sel: decodeSel(selPart),
    filters: { q: p.get("q") ?? "", all: p.get("all") === "1" },
  };
}

function seg(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s; // stray '%' in a hand-edited link
  }
}

function decodeSel(path: string): Selection | null {
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  const [tag, a, tag2, b] = parts;
  if (tag === "o" && a) return { kind: "output", path: a.split(".").map(seg).filter(Boolean) };
  if (tag === "c" && a && tag2 === "m" && b) return { kind: "module", configId: seg(a), moduleId: seg(b) };
  if (tag === "c" && a) return { kind: "config", configId: seg(a) };
  if (tag === "f" && a) return { kind: "file", fileId: seg(a) };
  if (tag === "i" && a) return { kind: "input", name: seg(a) };
  return null;
}

/** Same selection => filter-only change => replaceState instead of push. */
export function sameSelection(a: Selection | null, b: Selection | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  return encodeSel(a) === encodeSel(b);
}
