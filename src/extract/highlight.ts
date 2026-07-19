// Server-side syntax highlighting (Nix + bash phase scripts). Each grammar is
// vendored as WASM from nixpkgs' pkgsCross.wasi32.tree-sitter-grammars — a
// native build, no emscripten/npm grammar needed — and parses text once per
// request, resolving the highlight query's captures into flat,
// non-overlapping runs. Rendering (class names, colors) lives entirely on the
// client; this just says "these chars are a comment/keyword/string/...".
//
// Regenerate a vendored grammar (e.g. after a tree-sitter-{nix,bash} release):
//   nix build nixpkgs#pkgsCross.wasi32.tree-sitter-grammars.tree-sitter-nix -o /tmp/tsn
//   cp /tmp/tsn/parser.wasm src/extract/vendor/tree-sitter-nix.wasm
//   cp /tmp/tsn/queries/highlights.scm src/extract/vendor/nix-highlights.scm
//   (swap "nix" for "bash" for the other grammar)
//
// web-tree-sitter's Node/string capture offsets are UTF-16 code-unit indices
// (verified empirically against a multi-byte character) — directly usable
// as JS string slice indices, no UTF-8 byte conversion needed.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Language, Parser, Query } from "web-tree-sitter"
import type { TokenRun } from "../schema"

const VENDOR_DIR = join(import.meta.dir, "vendor")

type Lang = "nix" | "bash"

const GRAMMARS: Record<Lang, { wasm: string; highlights: string }> = {
  nix: { wasm: "tree-sitter-nix.wasm", highlights: "nix-highlights.scm" },
  bash: { wasm: "tree-sitter-bash.wasm", highlights: "bash-highlights.scm" },
}

/** Parser.init() loads the tree-sitter WASM runtime itself — shared by every grammar, so run once. */
let runtimeReady: Promise<void> | null = null
function initRuntime(): Promise<void> {
  if (!runtimeReady) runtimeReady = Parser.init()
  return runtimeReady
}

const languageReady = new Map<Lang, Promise<{ parser: Parser; query: Query }>>()

function init(lang: Lang): Promise<{ parser: Parser; query: Query }> {
  let p = languageReady.get(lang)
  if (!p) {
    const grammar = GRAMMARS[lang]
    p = (async () => {
      await initRuntime()
      const language = await Language.load(join(VENDOR_DIR, grammar.wasm))
      const parser = new Parser()
      parser.setLanguage(language)
      const query = new Query(language, readFileSync(join(VENDOR_DIR, grammar.highlights), "utf8"))
      return { parser, query }
    })()
    languageReady.set(lang, p)
  }
  return p
}

/**
 * Parse `text` in `lang` and resolve the highlight query's captures into
 * flat, non-overlapping runs: a narrower node wins over the broader one it
 * nests inside, and among captures on the exact same node the
 * earliest-declared query pattern wins — the highlights.scm convention,
 * since specific patterns are listed before the generic catch-alls they'd
 * otherwise lose to.
 */
async function tokenize(lang: Lang, text: string): Promise<TokenRun[]> {
  const { parser, query } = await init(lang)
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

export const tokenizeNix = (text: string): Promise<TokenRun[]> => tokenize("nix", text)
export const tokenizeBash = (text: string): Promise<TokenRun[]> => tokenize("bash", text)
