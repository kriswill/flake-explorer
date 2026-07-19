// Which self files reference `inputs.<name>` (or flake-parts' `inputs'.<name>`)
// in their source text. A regex scan like imports.ts — false positives are
// harmless in a visualization, and destructured input args (`outputs =
// { nixpkgs, ... }: …`) are invisible to any syntactic approach anyway.
// tree-sitter-nix is the named upgrade path.

import type { InputRef } from "../schema"

/** `inputs.<name>` / `inputs'.<name>` — first attr segment only (bare nix identifier). */
const INPUT_REF_RE = /\binputs'?\.([A-Za-z_][A-Za-z0-9_'-]*)/g

/**
 * Scan the given files (repo-relative paths) for input references.
 * `canonical` maps every referenceable name — real input names AND their
 * follows-aliases — to the canonical InputInfo name; unknown names are
 * dropped (locals like `inputs.self` or unrelated bindings named `inputs`).
 */
export async function scanInputRefs(
  relPaths: string[],
  canonical: ReadonlyMap<string, string>,
  read: (relPath: string) => Promise<string>,
  idOf: (relPath: string) => string,
): Promise<InputRef[]> {
  const refs: InputRef[] = []
  const seen = new Set<string>()

  for (const from of relPaths) {
    let text: string
    try {
      text = await read(from)
    } catch {
      continue
    }
    for (const m of text.matchAll(INPUT_REF_RE)) {
      const input = canonical.get(m[1]!)
      if (!input) continue
      const key = `${from}\x00${input}`
      if (seen.has(key)) continue
      seen.add(key)
      refs.push({ file: idOf(from), input })
    }
  }
  return refs
}

/** Name/alias → canonical name map for scanInputRefs, from Manifest.inputs. */
export function canonicalInputNames(
  inputs: Record<string, { name: string; aliases?: string[]; transitive?: true }>,
): Map<string, string> {
  const map = new Map<string, string>()
  for (const info of Object.values(inputs)) {
    if (info.transitive) continue // "parent/child" names can't appear as attr segments
    map.set(info.name, info.name)
    for (const a of info.aliases ?? []) map.set(a, info.name)
  }
  return map
}
