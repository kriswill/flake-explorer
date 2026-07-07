// Static file→file import graph over the flake's own .nix files. A regex
// scan, not a parser: dendritic flakes have near-zero manual imports, false
// positives are harmless in a visualization, and nix-instantiate --parse
// re-prints Nix (no JSON) so a "real" approach would still be text-munging.
// tree-sitter-nix is the named upgrade path.

import { dirname, join, normalize } from "node:path";
import type { ImportEdge } from "../schema";

/** Relative path tokens: ./x, ../x/y.nix, ./dir — quoted or bare. */
const REL_PATH = /\.{1,2}\/[\w@.+-]+(?:\/[\w@.+-]+)*/g;

/**
 * Build import edges between the given files (repo-relative paths).
 * `read` returns a file's text (from the local checkout or the store copy).
 */
export async function importGraph(
  relPaths: string[],
  read: (relPath: string) => Promise<string>,
  idOf: (relPath: string) => string,
): Promise<ImportEdge[]> {
  const known = new Set(relPaths);
  const edges: ImportEdge[] = [];
  const seen = new Set<string>();

  for (const from of relPaths) {
    let text: string;
    try {
      text = await read(from);
    } catch {
      continue;
    }
    const dir = dirname(from);
    for (const m of text.matchAll(REL_PATH)) {
      const target = normalize(join(dir, m[0]));
      if (target.startsWith("..")) continue; // escapes the flake root
      // Direct .nix reference, or a directory reference (dir/default.nix).
      const to = known.has(target)
        ? target
        : known.has(join(target, "default.nix"))
          ? join(target, "default.nix")
          : null;
      if (!to || to === from) continue;
      const key = `${from}\x00${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: idOf(from), to: idOf(to) });
    }
  }
  return edges;
}
