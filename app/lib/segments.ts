// Source-view segmentation shared by FileDetail and InputDetail: tree-sitter
// highlight runs (server-computed) and optional per-line file references
// (client-computed) are two independent interval sets over the same text —
// union their boundaries so a segment can carry both a token class and a ref
// link (e.g. a colored, clickable path literal).

import type { TokenRun } from "../../src/schema";

export interface Segment {
  text: string;
  /** FileEntry.id a resolvable "./"/"../" reference points at (clickable). */
  ref?: string;
  cls?: string;
}

export interface Interval<T> {
  start: number;
  end: number;
  value: T;
}

/** Tree-sitter capture name -> CSS class; unlisted/punctuation-ish captures render unstyled. */
export function tokenClass(name: string | undefined): string | undefined {
  switch (name) {
    case "comment":
      return "tok-comment";
    case "keyword":
      return "tok-keyword";
    case "number":
      return "tok-number";
    case "function":
      return "tok-function";
    case "function.builtin":
    case "variable.builtin":
      return "tok-builtin";
    case "property":
      return "tok-property";
    case "escape":
      return "tok-string";
    default:
      return name?.startsWith("string") ? "tok-string" : undefined;
  }
}

function coverAt<T>(intervals: Interval<T>[], pos: number): T | undefined {
  for (const iv of intervals) if (pos >= iv.start && pos < iv.end) return iv.value;
  return undefined;
}

/**
 * Split source text into per-line segments. `refsForLine` (line-local
 * offsets) yields the clickable file-reference intervals; omit it for a plain
 * highlighted view.
 */
export function segmentLines(
  text: string,
  tokens: TokenRun[],
  refsForLine?: (line: string) => Interval<string | undefined>[],
): Segment[][] {
  let lineStart = 0;
  return text.split("\n").map((line): Segment[] => {
    const lineEnd = lineStart + line.length;

    const refIntervals = refsForLine?.(line) ?? [];

    const tokenIntervals: Interval<string>[] = [];
    for (const t of tokens) {
      if (t.end <= lineStart || t.start >= lineEnd) continue;
      tokenIntervals.push({
        start: Math.max(t.start, lineStart) - lineStart,
        end: Math.min(t.end, lineEnd) - lineStart,
        value: t.name,
      });
    }

    const bounds = [
      ...new Set([
        0,
        line.length,
        ...refIntervals.flatMap((iv) => [iv.start, iv.end]),
        ...tokenIntervals.flatMap((iv) => [iv.start, iv.end]),
      ]),
    ].sort((a, b) => a - b);

    const segs: Segment[] = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      const p = bounds[i]!;
      const q = bounds[i + 1]!;
      if (p === q) continue;
      segs.push({
        text: line.slice(p, q),
        ref: coverAt(refIntervals, p),
        cls: tokenClass(coverAt(tokenIntervals, p)),
      });
    }
    if (segs.length === 0) segs.push({ text: "" });

    lineStart = lineEnd + 1; // +1 for the newline
    return segs;
  });
}
