// Relative-path reference matching, shared by the static import-graph
// extractor (src/extract/imports.ts, Node) and the in-browser file source
// view (app/components/FileDetail.svelte) — plain string ops only, no
// node:path, so the same resolution logic runs unmodified in both places.

/** Relative path tokens: ./x, ../x/y.nix, ./dir — quoted or bare. */
export const REL_PATH_RE = /\.{1,2}\/[\w@.+-]+(?:\/[\w@.+-]+)*/g

function dirname(relPath: string): string {
  const i = relPath.lastIndexOf("/")
  return i === -1 ? "" : relPath.slice(0, i)
}

/** Join a dir and a relative token (./x, ../x/y), collapsing . and .. segments. Null if it escapes the root. */
export function resolveRelRef(dir: string, token: string): string | null {
  const parts = (dir ? dir.split("/") : []).concat(token.split("/"))
  const out: string[] = []
  for (const part of parts) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      if (out.length === 0) return null
      out.pop()
    } else {
      out.push(part)
    }
  }
  return out.join("/")
}

/**
 * Resolve a relative reference found in `from`'s text against a set of known
 * relPaths (a single origin tree: the flake's own files, or one input's).
 * Falls back to `<target>/default.nix` the way Nix resolves directory imports.
 */
export function resolveKnownRef(
  from: string,
  token: string,
  known: ReadonlySet<string>,
): string | null {
  const target = resolveRelRef(dirname(from), token)
  if (target === null || target === from) return null
  if (known.has(target)) return target
  const withDefault = `${target}/default.nix`
  return known.has(withDefault) ? withDefault : null
}
