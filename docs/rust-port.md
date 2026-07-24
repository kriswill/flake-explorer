# The Rust port

The extractor, HTTP server, and static exporter — everything except the
Svelte SPA — have a complete Rust port under [`rust/`](../rust/). The SPA is
deliberately untouched: it consumes the same JSON contract
([`src/schema.ts`](../src/schema.ts)), and the Rust extractor's output was
verified field-for-field identical to the TypeScript implementation's against
real flakes, so the app cannot tell which produced its data. This page
records how the port was done, what it buys and costs, what remains before
it could fully replace the bun CLI, and an opinionated list of what to
improve next.

## How the port was done

**Module-per-module, schema first.** Each Rust module names its TypeScript
counterpart (`rust/src/manifest.rs` ↔ `src/extract/manifest.ts`; full map in
[`rust/README.md`](../rust/README.md)). The first thing ported was
`src/schema.ts` → `rust/src/schema.rs` as serde types with camelCase
renames and skip-if-`None` optionals, because the whole exercise stands or
falls on byte-compatible JSON shape: every later module was written against
that contract rather than against its own convenience.

**The Nix side is shared, not ported.**
[`src/extract/extract.nix`](../src/extract/extract.nix) is embedded in the
binary (`include_str!`) and materialized into `~/.cache/flake-explorer/`
keyed by content hash. Both implementations therefore evaluate literally the
same Nix code; the port's surface is orchestration, parsing, and serving.

**Syntax highlighting went native.** The TypeScript implementation loads
vendored WASM grammars through web-tree-sitter; the Rust port links
tree-sitter natively and compiles the same vendored highlight queries
([`src/extract/vendor/*.scm`](../src/extract/vendor/)). One contract detail
mattered: `TokenRun` offsets are UTF-16 code units (the client slices JS
strings with them), so the port converts tree-sitter's byte offsets before
emitting runs. Token output was verified byte-identical against the WASM
grammars on real files.

**The Svelte build stays in bun.**
[`scripts/bundle-app.ts`](../scripts/bundle-app.ts) prebuilds the SPA into an
`app-dist/` directory (JS, CSS, theme tokens, About data) that the Rust
binary locates at runtime — env var, exe-relative, repo checkout, or (in the
Nix package) `$out/share/flake-explorer/app-dist`. Rust composes the same
page HTML around it that `pageHtml()` does. `serve --dev` shells back out to
bun for rebuilds and pushes the same SSE reload.

**Verification was diff-based, not test-based.** Both extractors ran against
this repo's flake and a 57-input NixOS configuration; the manifests were
compared field-for-field and the full 15,436-option blob compared loc-by-loc
(identical modulo JSON key order). The one real divergence found became a
fix: nixpkgs modules occasionally set `defaultText = false` (a bare
boolean), which the untyped `JSON.parse` accepted silently — the Rust
deserializer initially rejected the whole chunk, and now coerces stray
scalars to their JSON rendering with a comment explaining why.

**The bun integration tests were ported, not re-imagined.**
`rust/tests/mini_flake.rs` runs the same real-nix fixture
([`test/fixtures/mini-flake`](../test/fixtures/mini-flake/)) as
`test/mini-flake.test.ts`; `rust/tests/{serve_http,degrade}.rs` reuse the
scripted-`nix`-shim technique. Two mechanical notes: the crate had to split
into lib + thin bin (a binary-only crate's `tests/` cannot link), and the
shim suites hold exactly one test per file — env/PATH mutation is
process-global, and each `tests/*.rs` file being its own process is what
makes it race-free.

**Packaging and CI use crane.** [`rust/package.nix`](../rust/package.nix)
builds with [crane](https://github.com/ipetkov/crane), chosen for
`buildDepsOnly`: the dependency tree compiles as its own derivation keyed
only by `Cargo.lock`, so CI pulls it from the binary cache and recompiles
just this crate on source changes. Coverage is `cargo-llvm-cov`, run twice:
as a sandboxed flake check (build gate), and outside the sandbox in CI where
real `nix` exists so the integration tests count — ~80% line coverage,
reported through octocov with its own artifact datastore
([`.octocov.rust.yml`](../.octocov.rust.yml)).

## Pros

- **A single native binary.** No bun runtime on the serving path; the binary
  embeds `extract.nix` and the highlight queries. Startup is milliseconds
  and the WASM tree-sitter initialization disappears entirely.
- **The type system audits the data.** Porting untyped `JSON.parse` flows
  into serde immediately surfaced a real upstream data quirk
  (`defaultText = false`) that TypeScript had been silently passing into
  blobs. The strict boundary is now a documented, deliberate coercion
  instead of an accident.
- **Memory-safe concurrency for the server.** The on-demand single-flight
  extraction, manifest swapping under `/api/refresh`, and SSE fan-out are
  now compiler-checked (`RwLock`/`watch`/`broadcast`) rather than
  convention-checked.
- **CI economics.** crane's dep-layer caching means a source-only change
  rebuilds one crate, not 300 dependencies; the FlakeHub cache carries the
  rest. Clippy at `--deny warnings` and rustfmt-via-treefmt are cheap to
  keep green from day one.
- **Verified parity.** Because verification was output-diffing against the
  live implementation, the port starts life with stronger evidence than most
  rewrites: same manifest, same blobs, same tokens.

## Cons

- **Two implementations of one contract.** `schema.rs` mirrors `schema.ts`
  by hand. Nothing structural stops them drifting — today the guarantee is
  the diff-verification discipline and the shared fixture tests, which is
  weaker than a generated contract (see improvements below).
- **Two toolchains to build one product.** The SPA still needs bun; a
  release of the Rust CLI is a cargo build *and* a bun bundle. The nix
  package hides this, but contributors now face Rust + TypeScript.
- **Extraction is no faster.** Wall time is bound by `nix eval`
  subprocesses (~74s for a real NixOS configuration either way). The port
  buys stability and startup, not evaluation speed — improving that needs
  changes to *how* Nix is driven, not the language driving it.
- **Deliberate divergences to remember.** The extractor fingerprint is
  `rs-`-prefixed so the two implementations never serve each other's cached
  blobs, and `safeName`'s collision hash differs (sha256-based vs wyhash) —
  only visible for attr names outside `[\w@+.-]`, but it means data dirs are
  per-implementation.
- **`serve --dev` depends on the repo.** Live-reload shells out to bun and
  watches `app/`; it is a checkout-only feature by design, and slightly more
  moving parts than bun watching its own sources.

## What full publishability still needs

1. **npm distribution.** The standard platform-package layout: one package
   per target (`-linux-x64`, `-linux-arm64`, `-darwin-arm64`, `-darwin-x64`)
   under `optionalDependencies`, a ~15-line launcher shim as the `bin` entry
   that resolves the platform binary and points `FLAKE_EXPLORER_APP_DIST` at
   the main package's bundled `app-dist/`. Crucially the published binaries
   must be **portable builds** (static musl for Linux, macOS-runner builds
   for Darwin) — the nix/crane binary links glibc from `/nix/store` and runs
   nowhere else. Publish with `--provenance`; macOS needs nothing beyond the
   linker's automatic ad-hoc signature; WASM is a non-starter (the program
   spawns `nix`/`git` and binds TCP — neither exists in WASI).
2. **Version single-sourcing.** `rust/Cargo.toml` carries its own version;
   the release workflow bumps `package.json`. Wire the crate version (and
   the About data) to the same source before any release ships.
3. **Release workflow integration.** A build matrix for the four targets,
   npm publish of the five packages, and a decision on rollout: a dist-tag
   soak (`@rust`) before switching the default, or a major-version cutover.
   The verified parity argues for a short soak, not a long one.
4. **Docs and packaging parity.** README/CLI docs mention the bun entry
   only; `packages.default` in the flake is still the bun package. Both are
   decisions to make explicitly, not oversights to paper over.
5. **Windows, or an explicit "no".** Neither implementation targets it
   (nix doesn't run there outside WSL); saying so in the README costs one
   sentence.

## Opinion: what to improve next

**Performance.** The honest ranking: (1) *Reduce nix invocations, not Rust
time.* Every options chunk is a full `nix eval` process — startup, eval,
JSON print. Batching sibling chunks into one eval that returns per-chunk
`tryEval` envelopes would cut process count severalfold without losing the
degrade ladder; that change lives in `extract.nix` and benefits both
implementations. (2) *A persistent evaluator* — the C API
(`libnixexpr`/nix-c-api bindings) would eliminate subprocess + JSON
round-trips entirely and enable incremental re-evaluation, but it couples
the binary to a specific Nix and forfeits the "your nix, your store paths"
property, so it should be an opt-in backend, never the default. (3) On the
server: pre-compress the page (it gzips ~4:1), send `ETag` on
`manifest.json` instead of re-serializing per poll, and run the per-package
`path-info` calls concurrently.

**Maintainability.** The highest-leverage change is ending the hand-mirrored
schema: generate `schema.ts` from the Rust types (`ts-rs`) or validate both
against one JSON Schema (`schemars`) in CI. Second: promote the verification
that made this port trustworthy into a permanent **parity check** — a CI job
that runs both extractors against the mini-flake fixture and diffs
normalized output; that turns "verified once" into "verified every commit"
and is the safety net for eventually retiring the bun extractor. Third:
consider the options worker pool's respawn loop — a channel-based
work-stealing pool would be simpler than the spawn-N-and-rejoin pattern
inherited from the TS code, now that the language offers better tools.

**Quality.** Fuzz the text scanners (`scan.rs`'s overlay walker and
`top_level_text` are classic fuzz targets; `cargo-fuzz` makes this an
afternoon). Add `cargo-deny`/`cargo-audit` to CI — the crate pulled in a
substantial dependency tree and nothing currently watches its advisories.
Adopt `tracing` behind a `-v` flag instead of bare `println!` — the serve
path especially would benefit from structured request/extraction spans.
And once the parity check exists, wire the mini-flake blob output into it as
golden fixtures so a schema change must consciously update both
implementations and the fixture in one commit.

The strategic opinion, briefly: keep the SPA in TypeScript forever (it is
the right tool), keep `extract.nix` as the single shared evaluator, and let
the parity check — not enthusiasm — decide when the bun extractor retires.
