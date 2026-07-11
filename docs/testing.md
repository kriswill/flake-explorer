# Testing

The whole suite runs under `bun test` — extractor code, SPA libraries, and Svelte components alike — with real-nix integration tests layered on top when `nix` is on PATH. See [Build & infra](build-and-infra.md) for the CI jobs that run it.

## Running

```sh
bun test              # full suite (nix-dependent tests skip if nix is absent)
bun test --coverage   # text + lcov reporters
```

[`bunfig.toml`](../bunfig.toml) preloads two setup files for every test run and configures coverage (lcov output, test files skipped, `test/**` ignored):

| Preload | Purpose |
|---|---|
| [`test/setup/happy-dom.ts`](../test/setup/happy-dom.ts) | Registers happy-dom as the global DOM and stubs `matchMedia` / `ResizeObserver`, which the viewer touches at init time |
| [`test/setup/svelte-loader.ts`](../test/setup/svelte-loader.ts) | A bun runtime plugin that compiles `.svelte` files with `svelte/compiler` (client output, injected CSS, runes) and `.svelte.ts` modules via `compileModule` — `bun-plugin-svelte` can't run under the test runtime because its virtual CSS imports need build-time resolution. It also swaps svelte's `index-server.js` package entries for their client siblings, since `bun test` resolves the "default" (server) export condition |

Component tests use the `withMount` helper in [`test/helpers.ts`](../test/helpers.ts): mount into a fresh host element, `flushSync()`, assert, always unmount.

## Test inventory

26 `*.test.ts` files under [`test/`](../test/helpers.ts), roughly four groups:

| Group | Files | Examples |
|---|---|---|
| Extractor & CLI unit tests | ~13 | [`test/options.test.ts`](../test/options.test.ts), [`test/manifest-show.test.ts`](../test/manifest-show.test.ts) (captured `nix flake show` JSON), [`test/cache.test.ts`](../test/cache.test.ts), [`test/imports.test.ts`](../test/imports.test.ts), [`test/highlight.test.ts`](../test/highlight.test.ts) (vendored tree-sitter WASM, no nix needed), [`test/cli-help.test.ts`](../test/cli-help.test.ts) (CLI as a subprocess), [`test/page-html.test.ts`](../test/page-html.test.ts) (the `</script>` escaping invariant) |
| SPA library tests | ~8 | [`test/state.test.ts`](../test/state.test.ts), [`test/state-loading.test.ts`](../test/state-loading.test.ts) (loads resolve through embedded `<script>` tags injected into happy-dom — no network), [`test/hash.test.ts`](../test/hash.test.ts), [`test/indexes.test.ts`](../test/indexes.test.ts), [`test/color.test.ts`](../test/color.test.ts), [`test/url.test.ts`](../test/url.test.ts) |
| Component tests | ~4 | [`test/app.test.ts`](../test/app.test.ts) (fixture data injected into the `app` singleton, components mounted under happy-dom), [`test/option-row.test.ts`](../test/option-row.test.ts), [`test/output-branch.test.ts`](../test/output-branch.test.ts), [`test/input-provenance.test.ts`](../test/input-provenance.test.ts) |
| Real-nix integration | 2 | [`test/mini-flake.test.ts`](../test/mini-flake.test.ts) (full `buildManifest` + `extractOptions` pipeline), [`test/export.test.ts`](../test/export.test.ts) (end-to-end single-file export, then re-parses the embedded data tags out of the HTML) |

## Fixture strategy

- [`test/fixtures/mini-flake/flake.nix`](../test/fixtures/mini-flake/flake.nix) — a real flake evaluated by real nix, but **builtins-only** (no nixpkgs), so evaluation is cheap and no store downloads happen. It hand-rolls just enough of the module-system option shape (`_type = "option"`, `declarations`, `definitionsWithLocations`) for the extractor's structural walk, and includes a nested `path:` input to exercise the Inputs panel.
- [`test/fixtures/broken-flake/flake.nix`](../test/fixtures/broken-flake/flake.nix) — a flake whose one configuration throws on evaluation: the attr name is enumerable but forcing the value fails, exercising the per-config error/degradation path without poisoning the healthy fixture.
- [`test/fixtures/data.ts`](../test/fixtures/data.ts) — hand-written `Manifest` / `ConfigData` / `OptionEntry` builders shared by unit and component tests, with fake store paths for self, inputs, and a patched-input copy.

## FLAKE_EXPLORER_REQUIRE_NIX

The integration suites use `describe.skipIf(!hasNix)`, which is right for local machines without nix but dangerous in CI — a skipped suite would only show up as a coverage drop. Setting `FLAKE_EXPLORER_REQUIRE_NIX=1` makes [`test/mini-flake.test.ts`](../test/mini-flake.test.ts) and [`test/export.test.ts`](../test/export.test.ts) throw at load time if `nix` is not on PATH. CI's test job sets it (with nix installed) so a silent skip is impossible — see [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

## Coverage and the Nix check

Coverage is enforced as a ratchet by octocov: [`.octocov.yml`](../.octocov.yml) reads `coverage/lcov.info` with `acceptable: current >= prev`, comparing PRs against the report stored from the default branch — coverage can rise but never regress. Current coverage sits in the mid-90s of lines.

Separately, `nix flake check` runs `checks.test` ([`flake.nix`](../flake.nix)): an offline `bun test` inside the build sandbox against the vendored `node_modules` from [`package.nix`](../package.nix). The sandbox has no nix binary, so the real-nix suites skip there by design; the CI `test` job is where they must run.
