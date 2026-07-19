// Content fingerprint of the extraction code itself — the "code" half of the
// cache key (cache.ts). Hashes every file under src/extract/ (including the
// vendored tree-sitter grammars, whose tokens land in package blobs) plus
// src/schema.ts, so any change to the code that shapes blob contents
// invalidates cached blobs with no manual version bump. Deliberately the
// whole directory rather than a curated list: orchestration-only edits cost
// one spurious re-extraction, while a forgotten list entry would silently
// serve stale data.

import { readdirSync, statSync } from "node:fs"
import { dirname, join } from "node:path"

let cached: Promise<string> | undefined

/** 16-hex-char fingerprint, memoized for the process lifetime. */
export function extractorFingerprint(): Promise<string> {
  cached ??= compute()
  return cached
}

async function compute(): Promise<string> {
  const srcDir = dirname(import.meta.dir)
  // Keyed by src/-relative path so the hash is stable across install locations.
  // *.test.ts is excluded from the published package (package.json files), so
  // it must be excluded here too or dev and installed fingerprints diverge.
  const rels = (readdirSync(import.meta.dir, { recursive: true }) as string[])
    .filter((p) => !p.endsWith(".test.ts"))
    .map((p) => join("extract", p))
    .concat("schema.ts")
    .sort()
  const hasher = new Bun.CryptoHasher("sha256")
  for (const rel of rels) {
    const abs = join(srcDir, rel)
    if (!statSync(abs).isFile()) continue
    hasher.update(`${rel}\0`)
    hasher.update(await Bun.file(abs).arrayBuffer())
    hasher.update("\0")
  }
  return hasher.digest("hex").slice(0, 16)
}
