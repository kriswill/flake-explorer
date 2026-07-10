// Server-side Nix syntax highlighting. tree-sitter-nix (WASM, vendored from
// nixpkgs' pkgsCross.wasi32.tree-sitter-grammars.tree-sitter-nix — a native
// build, no emscripten/npm grammar needed) parses each file once per request
// and resolves the highlight query's captures into flat, non-overlapping
// runs. Rendering (class names, colors) lives entirely on the client; this
// just says "these chars are a comment/keyword/string/...".
//
// Regenerate the vendored grammar (e.g. after a tree-sitter-nix release):
//   nix build nixpkgs#pkgsCross.wasi32.tree-sitter-grammars.tree-sitter-nix -o /tmp/tsn
//   cp /tmp/tsn/parser.wasm src/extract/vendor/tree-sitter-nix.wasm
//   cp /tmp/tsn/queries/highlights.scm src/extract/vendor/nix-highlights.scm
//
// web-tree-sitter's Node/string capture offsets are UTF-16 code-unit indices
// (verified empirically against a multi-byte character) — directly usable
// as JS string slice indices, no UTF-8 byte conversion needed.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Language, Parser, Query } from "web-tree-sitter"
import type { TokenRun } from "../schema"

const VENDOR_DIR = join(import.meta.dir, "vendor")

let ready: Promise<{ parser: Parser; query: Query }> | null = null

function init(): Promise<{ parser: Parser; query: Query }> {
  if (!ready) {
    ready = (async () => {
      await Parser.init()
      const language = await Language.load(join(VENDOR_DIR, "tree-sitter-nix.wasm"))
      const parser = new Parser()
      parser.setLanguage(language)
      const query = new Query(
        language,
        readFileSync(join(VENDOR_DIR, "nix-highlights.scm"), "utf8"),
      )
      return { parser, query }
    })()
  }
  return ready
}

/**
 * Parse `text` as Nix and resolve the highlight query's captures into flat,
 * non-overlapping runs: a narrower node wins over the broader one it nests
 * inside, and among captures on the exact same node the earliest-declared
 * query pattern wins — the highlights.scm convention, since specific
 * patterns are listed before the generic catch-alls they'd otherwise lose to.
 */
export async function tokenizeNix(text: string): Promise<TokenRun[]> {
  const { parser, query } = await init()
  const tree = parser.parse(text)
  if (!tree) return []
  try {
    const captures = query.captures(tree.rootNode)
    captures.sort((a, b) => {
      if (a.node.startIndex !== b.node.startIndex) return a.node.startIndex - b.node.startIndex
      const alen = a.node.endIndex - a.node.startIndex
      const blen = b.node.endIndex - b.node.startIndex
      if (alen !== blen) return blen - alen // broader first — narrower paints over it below
      return b.patternIndex - a.patternIndex // same node: earlier-declared pattern paints last (wins)
    })

    const paint = new Array<string | undefined>(text.length)
    for (const c of captures) {
      for (let i = c.node.startIndex; i < c.node.endIndex; i++) paint[i] = c.name
    }

    const runs: TokenRun[] = []
    let start = 0
    for (let i = 1; i <= text.length; i++) {
      if (i === text.length || paint[i] !== paint[start]) {
        if (paint[start]) runs.push({ start, end: i, name: paint[start]! })
        start = i
      }
    }
    return runs
  } finally {
    tree.delete()
  }
}
