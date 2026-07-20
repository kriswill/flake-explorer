// Which self files define `overlays.<name>` in their source text. This is
// the only defining-file signal available for overlays: `nix flake show`
// reports no position and the extractor never evaluates overlay bodies. A
// regex scan like input-refs.ts — false positives are harmless in a
// visualization, and anonymous overlays (`nixpkgs.overlays = [ (final:
// prev: …) ]`) are invisible to any syntactic approach anyway.
// tree-sitter-nix is the named upgrade path.
//
// Two definition shapes are recognized (both with an optional flake-parts
// `flake.` prefix):
//   overlays.<name> = <rhs>;                 — attr-path form
//   overlays = { <name> = <rhs>; … };        — block form
// When <rhs> is `import ./file.nix` resolving to a known self file, THAT
// file is recorded as the definition site — `kitten = import
// ../overlays/kitten.nix;` should point at kitten.nix, not the attach file.

import { REL_PATH_RE, resolveKnownRef } from "../pathref"
import type { OverlayDef } from "../schema"

// `(?<![\w'.-])` keeps `nixpkgs.overlays`/`inputs.x.overlays` (usages) from
// matching while still allowing the explicit `flake.` prefix; the `[^=]`
// tail keeps `==` comparisons out.
const ATTR_FORM_RE = /(?<![\w'.-])(?:flake\.)?overlays\.([A-Za-z_][A-Za-z0-9_'-]*)\s*=[^=]/g
const BLOCK_FORM_RE = /(?<![\w'.-])(?:flake\.)?overlays\s*=\s*(?:rec\s+)?\{/g
const ENTRY_RE = /(?:^|[;{])\s*([A-Za-z_][A-Za-z0-9_'-]*)\s*=([^;]*)/g

/** Scan the given files (repo-relative paths) for overlay definitions. */
export async function scanOverlayDefs(
  relPaths: string[],
  read: (relPath: string) => Promise<string>,
  idOf: (relPath: string) => string,
): Promise<OverlayDef[]> {
  const known = new Set(relPaths)
  const defs: OverlayDef[] = []
  const seen = new Set<string>()

  /** Definition site: the import target when <rhs> is a resolvable relative import, else `from`. */
  const siteOf = (from: string, rhs: string): string => {
    const m = rhs.match(/\bimport\s+(\S+)/)
    if (!m) return from
    const token = m[1]!.match(REL_PATH_RE)?.[0]
    return (token && resolveKnownRef(from, token, known)) || from
  }

  const add = (from: string, name: string, rhs: string) => {
    const file = idOf(siteOf(from, rhs))
    const key = `${name}\x00${file}`
    if (seen.has(key)) return
    seen.add(key)
    defs.push({ name, file })
  }

  for (const from of relPaths) {
    let text: string
    try {
      text = await read(from)
    } catch {
      continue
    }

    for (const m of text.matchAll(ATTR_FORM_RE)) {
      add(from, m[1]!, restOfStatement(text, m.index + m[0].length - 1))
    }

    for (const m of text.matchAll(BLOCK_FORM_RE)) {
      for (const e of topLevelText(text, m.index + m[0].length).matchAll(ENTRY_RE)) {
        add(from, e[1]!, e[2]!)
      }
    }
  }
  return defs
}

/** Text from `at` to the next `;` or newline — the attr form's <rhs>. */
function restOfStatement(text: string, at: number): string {
  let end = at
  while (end < text.length && text[end] !== ";" && text[end] !== "\n") end++
  return text.slice(at, end)
}

/**
 * The depth-1 text of a brace block starting right AFTER its `{`, with any
 * nested `{…}` bodies and `#` line comments blanked out — leaves `name =
 * rhs;` entries scannable while inline-attrset rhs (`foo = final: prev: {
 * … };`) can't leak fake entries and a `}` in a comment can't corrupt the
 * depth count. A heuristic character walk (string interpolation braces
 * count too), consistent with the file's regex-over-parser stance.
 */
function topLevelText(text: string, start: number): string {
  let depth = 1
  let out = ""
  for (let i = start; i < text.length && depth > 0; i++) {
    const c = text[i]!
    if (c === "#") {
      while (i < text.length && text[i] !== "\n") {
        out += " "
        i++
      }
      out += "\n"
      continue
    }
    if (c === "{") depth++
    else if (c === "}") depth--
    if (depth === 1) out += c
    else out += " "
  }
  return out
}
