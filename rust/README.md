# flake-explorer (Rust port)

A Rust port of the extractor and local HTTP server (`flake-explorer.ts` +
`src/extract/*` + `src/serve.ts` + `src/export.ts`). The Svelte SPA is
unchanged — it consumes the same JSON contract (`src/schema.ts`), and the
manifest this binary produces is field-for-field identical to the bun
extractor's (verified by diffing real extractions; only `generatedAt` and the
`extractor` fingerprint differ).

## Building

```sh
bun scripts/bundle-app.ts   # compile the Svelte SPA into rust/app-dist/
cargo build --release       # in rust/
```

The binary embeds `extract.nix` and the vendored highlight queries; the app
bundle (`app-dist/`) is located at runtime via `$FLAKE_EXPLORER_APP_DIST`,
next to the executable, `../share/flake-explorer/app-dist`, or the repo
checkout (where it is rebuilt automatically via bun if missing).

## What's different from the bun implementation

- **Syntax highlighting is native tree-sitter** (crates), not WASM. Token
  output was verified byte-identical against the WASM grammars on real
  files. `TokenRun` offsets remain UTF-16 code units per the client contract.
- **The extractor fingerprint is `rs-`-prefixed** (computed by `build.rs`
  over the Rust sources + `extract.nix` + highlight queries), so blobs cached
  by one implementation are never served by the other — their token output
  could differ on grammar-version edges.
- **`safeName` collision hashes differ** (sha256-based rather than wyhash).
  Only affects data-file names of configs/packages whose attr names contain
  characters outside `[\w@+.-]` — such blobs re-extract when switching tools.
- **`--dev`** watches `app/` and shells out to `bun scripts/bundle-app.ts`
  for rebuilds (bun still owns Svelte compilation), then pushes the same SSE
  reload the bun server does.

## Layout

Module-per-module port; each file names its TypeScript counterpart:

| Rust                | TypeScript                                     |
| ------------------- | ---------------------------------------------- |
| `main.rs`           | `flake-explorer.ts`                            |
| `schema.rs`         | `src/schema.ts`                                |
| `run_nix.rs`        | `src/extract/run-nix.ts`                       |
| `manifest.rs`       | `src/extract/manifest.ts`                      |
| `options.rs`        | `src/extract/options.ts`                       |
| `package.rs`        | `src/extract/package.ts`                       |
| `cache.rs`          | `src/extract/cache.ts`                         |
| `scan.rs`           | `src/extract/{imports,input-refs,overlay-refs}.ts` |
| `git.rs`            | `src/extract/git.ts`                           |
| `highlight.rs`      | `src/extract/highlight.ts`                     |
| `reverse_deps.rs`   | `src/extract/reverse-deps.ts`                  |
| `pathref.rs`        | `src/pathref.ts`                               |
| `serve.rs`          | `src/serve.ts`                                 |
| `export.rs`         | `src/export.ts` (+ the `resolveFile` slice of `app/lib/indexes.ts`) |
| `page.rs`           | `src/build-app.ts` (page composition half)     |
| `build.rs`          | `src/extract/fingerprint.ts`                   |
