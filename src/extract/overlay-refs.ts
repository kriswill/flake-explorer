// Which self files define `overlays.<name>` in their source text, and — best
// effort — the top-level attrs each overlay body adds/overrides. This is the
// only defining-file signal available for overlays: `nix flake show` reports no
// position and the extractor never evaluates overlay bodies. A regex scan like
// input-refs.ts — false positives are harmless in a visualization, and
// anonymous overlays (`nixpkgs.overlays = [ (final: prev: …) ]`) are invisible
// to any syntactic approach anyway. tree-sitter-nix is the named upgrade path.
//
// Two definition shapes are recognized (both with an optional flake-parts
// `flake.` prefix):
//   overlays.<name> = <rhs>;                 — attr-path form
//   overlays = { <name> = <rhs>; … };        — block form
// When <rhs> is `import ./file.nix` resolving to a known self file, THAT file
// is recorded as the definition site — `kitten = import ../overlays/kitten.nix;`
// should point at kitten.nix, not the attach file — and the overlay body is
// read from there (a whole-file `final: prev: { … }`). Otherwise the body is
// inline at the rhs position.

import { REL_PATH_RE, resolveKnownRef } from "../pathref"
import type { OverlayAttr, OverlayDef } from "../schema"

// `(?<![\w'.-])` keeps `nixpkgs.overlays`/`inputs.x.overlays` (usages) from
// matching while still allowing the explicit `flake.` prefix; the `[^=]`
// tail keeps `==` comparisons out.
const ATTR_FORM_RE = /(?<![\w'.-])(?:flake\.)?overlays\.([A-Za-z_][A-Za-z0-9_'-]*)\s*=[^=]/g
const BLOCK_FORM_RE = /(?<![\w'.-])(?:flake\.)?overlays\s*=\s*(?:rec\s+)?\{/g
const ENTRY_RE = /(?:^|[;{])\s*([A-Za-z_][A-Za-z0-9_'-]*)\s*=([^;]*)/g

// The overlay body lambda: `final: prev: {`, `self: super: {`, underscore- or
// `@`-pattern variants (`_final: prev@{ … }: {`). Group 2 is the "prev"/"super"
// binding name — a dotted use of it (`prev.foo`) marks an attr as an override.
// Anchored with ^: the header must sit at the rhs start (after leading trivia),
// so a non-lambda rhs can't reach forward and adopt a LATER overlay's body.
const OVERLAY_LAMBDA_RE =
  /^(_?[A-Za-z][\w'-]*)(?:\s*@\s*\{[^{}]*\})?\s*:\s*(_?[A-Za-z][\w'-]*)(?:\s*@\s*\{[^{}]*\})?\s*:\s*(?:rec\s+)?\{/

/** Scan the given files (repo-relative paths) for overlay definitions. */
export async function scanOverlayDefs(
  relPaths: string[],
  read: (relPath: string) => Promise<string>,
  idOf: (relPath: string) => string,
): Promise<OverlayDef[]> {
  const known = new Set(relPaths)
  const defs: OverlayDef[] = []
  const seen = new Set<string>()

  // An imported overlay body may be attached from several files; read each once.
  const textCache = new Map<string, string | null>()
  const readCached = async (rel: string): Promise<string | null> => {
    if (textCache.has(rel)) return textCache.get(rel) ?? null
    let text: string | null
    try {
      text = await read(rel)
    } catch {
      text = null
    }
    textCache.set(rel, text)
    return text
  }

  /** Definition-site relPath: the import target when <rhs> is a resolvable relative import, else `from`. */
  const siteRelOf = (from: string, rhs: string): string => {
    const m = rhs.match(/\bimport\s+(\S+)/)
    if (!m) return from
    const token = m[1]!.match(REL_PATH_RE)?.[0]
    return (token && resolveKnownRef(from, token, known)) || from
  }

  /**
   * Record one overlay def with its enumerated attrs. `text`/`rhsStart` locate
   * the inline body; when the rhs is a resolvable import, the body is the whole
   * imported file instead.
   */
  const add = async (from: string, name: string, rhs: string, text: string, rhsStart: number) => {
    const siteRel = siteRelOf(from, rhs)
    const file = idOf(siteRel)
    const key = `${name}\x00${file}`
    if (seen.has(key)) return
    seen.add(key)

    let body: string | null
    let bodyStart: number
    if (siteRel === from) {
      body = text
      bodyStart = rhsStart
    } else {
      body = await readCached(siteRel)
      bodyStart = 0
    }
    const attrs = body ? enumerateOverlayAttrs(body, bodyStart) : []
    defs.push(attrs.length ? { name, file, attrs } : { name, file })
  }

  for (const from of relPaths) {
    let text: string
    try {
      text = await read(from)
    } catch {
      continue
    }

    for (const m of text.matchAll(ATTR_FORM_RE)) {
      // m[0] ends with `=` + one lookahead char, so the rhs begins at its end - 1.
      const rhsStart = m.index + m[0].length - 1
      await add(from, m[1]!, restOfStatement(text, rhsStart), text, rhsStart)
    }

    for (const m of text.matchAll(BLOCK_FORM_RE)) {
      const blockStart = m.index + m[0].length
      const block = topLevelText(text, blockStart)
      for (const e of block.matchAll(ENTRY_RE)) {
        // topLevelText preserves offsets (nested chars are blanked, not removed),
        // so an entry at e.index in the blanked block maps to the same offset in
        // the original text — where an inline lambda body is still intact.
        const rhsStart = blockStart + e.index + e[0].indexOf("=") + 1
        await add(from, e[1]!, e[2]!, text, rhsStart)
      }
    }
  }
  return defs
}

/**
 * Enumerate the top-level attrs of the overlay lambda whose body begins (after
 * leading whitespace/comments) at `from` in `text`. Requires the
 * `final: prev: { … }` header right there — a `let … in <lambda>` overlay file
 * won't match (documented limit) but nothing forward-matches the wrong body.
 * Walks the body at depth 1 and marks each attr add vs override.
 */
function enumerateOverlayAttrs(text: string, from: number): OverlayAttr[] {
  const start = skipTrivia(text, from)
  const header = text.slice(start).match(OVERLAY_LAMBDA_RE)
  if (!header) return []
  const prevName = header[2]! // "prev"/"super" — its dotted use marks an override
  const braceAt = start + header[0].length // just past the body-opening `{`
  const body = topLevelText(text, braceAt)

  // `prev.<x>` / `super.<x>` access, or `.override`/`.overrideAttrs`, means the
  // entry patches the prior package rather than adding a fresh one. `_` is the
  // Nix throwaway binding — nothing can reference it.
  const prevRe = prevName === "_" ? null : new RegExp(`(?<![\\w'-])${escapeRe(prevName)}\\.`)
  const OVERRIDE_CALL_RE = /\.overrideAttrs\b|\.override\b/

  const attrs: OverlayAttr[] = []
  const seen = new Set<string>()
  for (const e of body.matchAll(ENTRY_RE)) {
    const name = e[1]!
    if (seen.has(name)) continue
    seen.add(name)
    const rhs = e[2] ?? ""
    const override = (prevRe?.test(rhs) ?? false) || OVERRIDE_CALL_RE.test(rhs)
    attrs.push({ name, kind: override ? "override" : "add" })
  }
  return attrs
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\'-]/g, "\\$&")

// Advance past whitespace, `#` line comments, and `/* … */` Nix block comments.
function skipTrivia(text: string, i: number): number {
  for (;;) {
    while (i < text.length && /\s/.test(text[i]!)) i++
    if (text[i] === "#") {
      while (i < text.length && text[i] !== "\n") i++
      continue
    }
    if (text[i] === "/" && text[i + 1] === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i += 2
      continue
    }
    return i
  }
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
 * count too), consistent with the file's regex-over-parser stance. Output
 * length matches the consumed span, so caller offsets stay aligned.
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
