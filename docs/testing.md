# Testing

Two suites, split by language and run by different tools:

- **`cargo test`** — the Rust workspace: extractor, server, export, CLI. Unit tests live inline in each crate's sources (`src/*.rs` and `crates/extract/src/*.rs`); integration suites live in [`tests/`](../tests), belong to the root crate, and drive the real binary or an in-process `axum` router. Both members are in the workspace's `default-members`, so a bare `cargo test` covers both — without that, cargo would select only the root package and silently skip the extraction crate's unit tests.
- **`bun test`** — the Svelte SPA and the bun build scripts. Every `*.test.ts` sits beside the module it covers.

See [Build & infra](build-and-infra.md) for the CI jobs that run them.

## Running

```sh
cargo test            # Rust; real-nix suites skip when nix is absent
bun test              # SPA + build scripts
bun test --coverage   # text + lcov reporters, into dist/coverage/
```

## The bun suite

[`bunfig.toml`](../bunfig.toml) preloads two setup files for every run and configures coverage (lcov output, test files skipped, `web/testing/**` ignored):

| Preload | Purpose |
|---|---|
| [`web/testing/happy-dom.ts`](../web/testing/happy-dom.ts) | Registers happy-dom as the global DOM and stubs `matchMedia` / `ResizeObserver`, which the viewer touches at init time |
| [`web/testing/svelte-loader.ts`](../web/testing/svelte-loader.ts) | A bun runtime plugin that compiles `.svelte` files with `svelte/compiler` (client output, injected CSS, runes) and `.svelte.ts` modules via `compileModule` — `bun-plugin-svelte` can't run under the test runtime because its virtual CSS imports need build-time resolution. It also swaps svelte's `index-server.js` package entries for their client siblings, since `bun test` resolves the "default" (server) export condition |

Component tests use the `withMount` helper in [`web/testing/helpers.ts`](../web/testing/helpers.ts): mount into a fresh host element, `flushSync()`, assert, always unmount.

Tests are **co-located**: [`web/lib/indexes.test.ts`](../web/lib/indexes.test.ts) sits next to `indexes.ts`, [`web/components/OptionRow.test.ts`](../web/components/OptionRow.test.ts) next to `OptionRow.svelte`. Finding a module's tests is a directory listing, not a search.

| Group | Files | Location |
|---|---|---|
| Component tests | 19 | `web/components/*.test.ts`, plus [`web/App.test.ts`](../web/App.test.ts) (fixture data injected into the `app` singleton, components mounted under happy-dom) |
| SPA library tests | 14 | `web/lib/*.test.ts` — state, indexes, schema, search, segments, colors, URL/hash routing, diffing |
| Build-script tests | 3 | [`scripts/build-app.test.ts`](../scripts/build-app.test.ts) (the `</script>` escaping invariant), [`scripts/licenses.test.ts`](../scripts/licenses.test.ts), [`scripts/release.test.ts`](../scripts/release.test.ts) |

## The Rust suite

Unit tests live inline beside the code, in `src/*.rs` for the root crate and `crates/extract/src/*.rs` for the extractor. The integration suites in [`tests/`](../tests) share helpers via [`tests/common/mod.rs`](../tests/common/mod.rs):

| Suite | Covers |
|---|---|
| [`tests/cli.rs`](../tests/cli.rs) | The binary's flag parsing and help/usage surface, as a subprocess |
| [`tests/serve_http.rs`](../tests/serve_http.rs) | The whole route surface against an in-process `axum` router, using a `nix` shim on PATH — no real evaluation |
| [`tests/export_html.rs`](../tests/export_html.rs) | End-to-end single-file export, re-parsing the embedded data tags out of the HTML |
| [`tests/degrade.rs`](../tests/degrade.rs) | Per-configuration failure paths — one bad config must not poison the rest |
| [`tests/mini_flake.rs`](../tests/mini_flake.rs) | The full manifest + option-extraction pipeline against **real nix** |
| [`tests/determinism.rs`](../tests/determinism.rs) | The two guards on "a blob is a function of the extraction crate and the flake": repeated extractions must be byte-identical (real nix), and the root crate must not grow a new file-writing site (runs everywhere) |

The second suite is the only thing in the repo that fails when the extraction
boundary stops holding — see [The extraction crate boundary](extraction-pipeline.md#the-extraction-crate-boundary).
Its own comment is explicit about what it cannot catch, which is worth reading
before relying on it.

## Fixture strategy

- [`fixtures/mini-flake/flake.nix`](../fixtures/mini-flake/flake.nix) — a real flake evaluated by real nix, but **builtins-only** (no nixpkgs), so evaluation is cheap and no store downloads happen. It hand-rolls just enough of the module-system option shape (`_type = "option"`, `declarations`, `definitionsWithLocations`) for the extractor's structural walk, and includes a nested `path:` input to exercise the Inputs panel.
- [`fixtures/broken-flake/flake.nix`](../fixtures/broken-flake/flake.nix) — a flake whose one configuration throws on evaluation: the attr name is enumerable but forcing the value fails, exercising the per-config error/degradation path without poisoning the healthy fixture.
- [`web/testing/fixtures.ts`](../web/testing/fixtures.ts) — hand-written `Manifest` / `ConfigData` / `OptionEntry` builders shared by the SPA unit and component tests, with fake store paths for self, inputs, and a patched-input copy.

The nix fixtures live at the repo root rather than under `tests/` on purpose: `tests/` is in the crate's Nix fileset (see below), so nesting them there would make every fixture edit invalidate the crane dependency layer.

## FLAKE_EXPLORER_REQUIRE_NIX

The real-nix suites skip when `nix` is not on PATH, which is right for local machines without nix but dangerous in CI — a skipped suite would only show up as a coverage drop. Setting `FLAKE_EXPLORER_REQUIRE_NIX=1` makes `common::nix_available()` panic instead of skipping ([`tests/common/mod.rs`](../tests/common/mod.rs)). CI's coverage step sets it, with nix installed, so a silent skip is impossible — see [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

## Coverage and the Nix checks

Two octocov reports, deliberately separate so their histories never mix:

- [`.octocov.yml`](../.octocov.yml) — the SPA suite, reading `dist/coverage/lcov.info` against a fixed `acceptable: 96%` floor.
- [`.octocov.rust.yml`](../.octocov.rust.yml) — the crate, reading `rust-coverage/lcov.info` as a `current >= prev` ratchet.

`nix flake check` builds four checks from [`package.nix`](../package.nix): `test` (`cargo test`), `clippy`, `coverage`, and `app-test` (an offline `bun test` against the vendored `node_modules`). The sandbox has no `nix` binary and the fixture flakes are outside the crate fileset, so the real-nix suites skip there by design — CI's out-of-sandbox `cargo llvm-cov test` step is where they must run.
