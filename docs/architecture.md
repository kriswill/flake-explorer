# Architecture

flake-explorer is three cooperating layers: a native Rust CLI/extraction layer
that drives the host `nix` binary, a JSON data directory that both persists and
caches extraction results, and a Svelte 5 SPA that consumes those documents
either over HTTP or embedded in a single exported HTML file. The contract
between the layers is one file, mirrored on each side:
[`src/schema.rs`](../src/schema.rs) and [`web/lib/schema.ts`](../web/lib/schema.ts).

## System overview

The CLI ([`src/main.rs`](../src/main.rs)) parses flags,
canonicalizes the flakeref, and dispatches to `extract`, `export`, or `serve`.
`extract` and `export` share [`src/drive.rs`](../src/drive.rs)
(`extract_to_dir`), which builds the manifest, reconciles the on-disk cache, and
extracts requested configurations. All Nix evaluation goes through
[`src/run_nix.rs`](../src/run_nix.rs), a thin JSON-in/JSON-out
wrapper that runs `nix eval --impure --json` on
[`src/extract.nix`](../src/extract.nix).

The SPA is not built by the binary. `bun scripts/bundle-app.ts` compiles it
ahead of time into `dist/app/`, and the binary locates that bundle at runtime
([`src/page.rs`](../src/page.rs)) to compose the page.

```mermaid
flowchart TD
  cli["main.rs CLI dispatch"] --> drive["drive.rs extract_to_dir"]
  drive --> manifest["manifest.rs build_manifest"]
  drive --> options["options.rs extract_options"]
  manifest --> runnix["run_nix.rs"]
  options --> runnix
  runnix --> nix["host nix binary evaluating extract.nix"]
  drive --> data["data dir: manifest.json + config blobs + .meta.json sidecars"]
  cli --> serve["serve.rs on-demand extraction + HTTP"]
  cli --> export["export.rs single-file HTML"]
  data --> serve
  data --> export
  app["prebuilt SPA bundle in dist/app"] --> serve
  app --> export
```

The data dir (default `./flake-explorer-data`) holds `manifest.json`, one
`config/<kind>.<name>.json` blob per extracted configuration, and a
`.meta.json` sidecar per blob recording the flake narHash and extractor
version that produced it ([`src/cache.rs`](../src/cache.rs)).
Two consumers read it: [`src/serve.rs`](../src/serve.rs) serves the SPA plus
data over HTTP, extracting pending configurations on demand (single-flight per
config, request held open); [`src/export.rs`](../src/export.rs) composes the
SPA and every data document into one standalone HTML file that works from
`file://` with no server. Both load the same prebuilt bundle through
[`src/page.rs`](../src/page.rs).

## Design decisions

- **Host nix, never vendored.** The `nix` on PATH is deliberately the user's
  own — [`package.nix`](../package.nix) never vendors one and
  [`flake.nix`](../flake.nix) deliberately keeps nix out of the dev shell — so
  store paths and the flake registry match the user's system.
  [`src/run_nix.rs`](../src/run_nix.rs) checks version >= 2.19
  at startup and forces `lazy-trees = false` so store paths join across evals.
- **Chunk-by-chunk option walk.** `builtins.tryEval` cannot catch
  missing-attribute/type errors, so one poisoned option would kill an entire
  eval. [`src/options.rs`](../src/options.rs) walks options per
  top-level namespace, recursively halving failing chunks to isolate the bad
  option; only an unsplittable chunk descends the degradation ladder
  (full → no values → no values+descriptions) before being abandoned.
- **Bun.build, not Vite.** [`scripts/build-app.ts`](../scripts/build-app.ts) bundles
  the Svelte 5 (runes) SPA with `Bun.build` + `bun-plugin-svelte` — no separate
  build tool or dev server. [`scripts/bundle-app.ts`](../scripts/bundle-app.ts)
  writes the result to `dist/app/` as `app.js`, `app.css`, and a `meta.json`
  carrying the generated theme CSS and About data, which is the whole interface
  between the bun side and the Rust binary.
- **One shared data contract.** [`src/schema.rs`](../src/schema.rs) defines
  both documents (cheap `Manifest`, expensive per-config `ConfigData`) for the
  extractor and the SPA alike, with `storePath` as the universal join key
  between file entries and option declarations/definitions. See
  [Data schema](data-schema.md).

## Directory map

| Path | Contents |
| --- | --- |
| [`src/`](../src) | The Rust crate — CLI entry ([`main.rs`](../src/main.rs)), server ([`serve.rs`](../src/serve.rs)), static export ([`export.rs`](../src/export.rs)), page composition ([`page.rs`](../src/page.rs)), the data contract ([`schema.rs`](../src/schema.rs)), and the extractor ([`drive.rs`](../src/drive.rs), [`manifest.rs`](../src/manifest.rs), [`options.rs`](../src/options.rs), [`cache.rs`](../src/cache.rs), [`run_nix.rs`](../src/run_nix.rs), [`extract.nix`](../src/extract.nix)). |
| [`src/vendor/`](../src/vendor) | Vendored tree-sitter highlight queries (`nix-highlights.scm`, `bash-highlights.scm`) for server-side tokenizing. |
| [`web/`](../web) | The SPA: [`App.svelte`](../web/App.svelte), `components/`, and `lib/` (state, indexes, colors, URL routing), each with its `*.test.ts` alongside. See [Frontend](frontend.md). |
| [`web/testing/`](../web/testing) | Bun-test support: preloads, the `withMount` helper, and the shared fixture builders. |
| [`tests/`](../tests) | Rust integration suites (CLI, serve, export, degradation, real-nix). See [Testing](testing.md). |
| [`fixtures/`](../fixtures) | Nix fixture flakes the Rust suites evaluate (`mini-flake`, `broken-flake`). |
| [`bin/`](../bin) | [`flake-explorer.mjs`](../bin/flake-explorer.mjs) — npm launcher that resolves the platform binary package and execs it with this package's SPA bundle. |
| [`scripts/`](../scripts) | Bun tooling: SPA bundling ([`bundle-app.ts`](../scripts/bundle-app.ts), [`build-app.ts`](../scripts/build-app.ts)), docs site ([`build-docs.ts`](../scripts/build-docs.ts)), npm staging ([`build-npm.ts`](../scripts/build-npm.ts)), release ([`release.ts`](../scripts/release.ts)). |
| `dist/` | All build output, git-ignored: `app/` (SPA bundle), `npm/` (staged packages), `site/` (Pages), `api/` (typedoc), `coverage/`. |
| [`.github/workflows/`](../.github/workflows) | CI ([`ci.yml`](../.github/workflows/ci.yml)) and Pages publishing ([`pages.yml`](../.github/workflows/pages.yml)). See [Build & infra](build-and-infra.md). |
