# flake-explorer — repository layout review

## What's actually here

Tracked source roots (8):

| dir | contents | owner |
|---|---|---|
| `src/` | 18 `.rs` + `extract.nix` + `vendor/*.scm` | cargo |
| `tests/` | 5 integration `.rs` + `common/mod.rs` | cargo |
| `web/` | `App.svelte`, `main.ts`, `components/` (28), `lib/` (16) | bun |
| `test/` | 37 flat `*.test.ts`, `helpers.ts`, `setup/` (2), `fixtures/` | bun **and cargo** |
| `scripts/` | 7 bun build/release scripts | bun |
| `bin/` | 1 npm launcher shim | npm |
| `docs/` | 9 `.md` + `preview.png` | docs site |
| `.github/`, `.agents/` | CI, skills | — |

Ignored roots (10): `app-dist/ dist-npm/ _site/ .docs-api/ coverage/ target/ result*
flake-explorer-data/ node_modules/ .direnv/`

So `ls` at the repo root shows more generated noise than source.

## Findings, in order of cost to a maintainer

### 1. `test/` vs `tests/` — one letter, two languages, two runners

- `tests/` = cargo integration tests (Cargo-mandated location)
- `test/` = bun SPA suite (chosen location)

And they are entangled: `tests/common/mod.rs:9` reaches into
`test/fixtures/mini-flake`. So the Rust suite's fixtures live under the
TypeScript suite's directory, with nothing in either name to say so.

### 2. `src/` means "Rust only", but `web/` is source too

`src/` is Cargo's default and cannot move without a workspace. `web/` is a
neutral word that doesn't disambiguate against it. Someone grepping `src/`
misses half the product.

### 3. 37 flat test files, no visible mapping onto 44 modules

`test/` is a flat list; `web/` has 28 components + 16 lib modules; 3 of the
tests actually target `scripts/`, not `web/`, and nothing says so.

### 4. Ten ignored output roots

`.gitignore` already lists a `dist/` that doesn't exist — the intent was
there once.

### 5. Pre-existing bug (not layout taste): `tests/` is absent from the crate's Nix fileset

`package.nix:25-33` builds `src` from `Cargo.toml`, `Cargo.lock`, `build.rs`,
`./src` only. Three independent confirmations:

```
$ nix derivation show .#flake-explorer.passthru.checks.test | jq '.derivations|to_entries[0].value.env.src'
"/nix/store/39blib8drfmapdi74ylffsqysmanpwsk-source"

$ ls /nix/store/39blib8drfmapdi74ylffsqysmanpwsk-source
Cargo.lock  Cargo.toml  build.rs  src/          # no tests/

$ zstd -dc <check-out>/target.tar.zst | tar -t | grep -E 'deps/(cli|degrade|export_html|serve_http|mini_flake)-'
                                                # empty — only flake_explorer-* (lib + bin)
```

`craneLib.cargoTest` and `cargoClippy --all-targets` therefore compile and run
**zero** integration tests. Two comments in the repo describe the opposite:

- `.github/workflows/ci.yml:72` — "the sandboxed cargo tests run the shim-based
  integration suites but skip the real-nix mini-flake suite". The first half is
  not true.
- `tests/common/mod.rs:1` — "tests skip when `nix` is absent (the crane check
  sandbox)". That gating branch is unreachable; nothing in `tests/` ever runs
  in the sandbox.

All five suites only ever execute in the out-of-sandbox `cargo llvm-cov test`
step (ci.yml:83), which is why this has stayed invisible: coverage still
reports them.

## How comparable projects lay this out

| project | shape | top-level |
|---|---|---|
| rust-lang/mdBook | Rust binary embedding a JS/CSS frontend — closest analogue | `crates/`, `src/`, `tests/`, `guide/`; frontend at `crates/mdbook-html/front-end/` beside the Rust that serves it |
| svenstaro/miniserve | single-crate Rust web server + assets | `src/`, `data/`, `tests/`, `packaging/` |
| Canop/bacon | single-crate Rust + site | `src/`, `defaults/`, `resources/`, `website/`, `doc/` |
| biomejs/biome | Rust + JS packages | `crates/`, `packages/`, `scripts/`, `xtask/`, `e2e-tests/` |
| oxc-project/oxc | Rust + JS | `crates/`, `apps/`, `napi/`, `npm/`, `tasks/` |
| rust-lang/rust-analyzer | Rust + editor clients | `crates/`, `editors/`, `lib/`, `xtask/` |
| rolldown/rolldown | Rust + JS | `crates/`, `packages/`, `scripts/`, `tasks/` |
| denoland/deno | Rust | `cli/`, `ext/`, `runtime/`, `tests/`, `tools/` |

Two conventions hold across all eight:

1. Non-Rust source gets a **contentful** name (`front-end`, `data`, `website`,
   `packages`, `editors`, `apps`) — never a neutral one competing with `src/`.
2. **Nobody has both `test/` and `tests/`.** Where a second suite exists it is
   named for what it tests (`e2e-tests/`), not for being tests.

Multi-crate `crates/` layouts appear everywhere, but every one of those repos
has 5–100 crates. mdBook only adopted it after splitting into 8. One crate does
not earn it.

## Recommended layout

```
flake-explorer/
├── src/                   Rust crate                        (unchanged — Cargo)
├── tests/                 Rust integration tests + common/  (unchanged — Cargo)
├── fixtures/              mini-flake/, broken-flake/        ← from test/fixtures/
├── web/                   Svelte SPA                        ← from app/
│   ├── main.ts  App.svelte  css.d.ts
│   ├── components/          *.svelte + *.test.ts co-located
│   ├── lib/                 *.ts + *.test.ts co-located
│   └── testing/             happy-dom.ts, svelte-loader.ts, helpers.ts, data.ts
├── scripts/               build/release + their 3 co-located tests
├── bin/                   npm launcher
├── docs/
└── dist/                  app/  npm/  site/  api/  coverage/   (one ignored root)
```

Root goes from 8 tracked + 10 ignored dirs to 7 tracked + 3 ignored
(`dist/`, `target/`, `node_modules/`).

### Rejected

- **Cargo workspace / `crates/flake-explorer/`** — the dominant Rust+JS
  convention, but it buys nothing for one crate and adds a path level to every
  Nix fileset, CI path, and doc reference. Against the "simplicity" ask.
- **Renaming `src/` or `tests/`** — Cargo discovers integration tests only at
  `<package-root>/tests/`, and `src/lib.rs`/`src/main.rs` are its defaults.
  Fixed unless the crate moves into a subdir (see above).
- **Renaming the published/installed `app-dist`** — `package.json` `files:`,
  `bin/flake-explorer.mjs` `../app-dist`, and
  `$out/share/flake-explorer/app-dist` are a shipped contract. The repo-local
  build dir is independent of them and can move; the contract shouldn't.

## Migration tiers

**Tier 0 — the bug, independent of any layout change.** Add `./tests` to
`package.nix` `commonArgs.src`; correct the ci.yml:72 and `tests/common/mod.rs:1`
comments. The nix-gated skip in `common/mod.rs` then starts doing its job. Do
**not** add the fixtures to that fileset — the four shim-based suites need no
fixture files to compile or run, and `mini_flake.rs` skips in-sandbox anyway
(no `nix` on PATH). Keeping fixtures out means editing a fixture never
invalidates `cargoArtifacts`.

**Tier 1 — kill the `test/`/`tests/` collision.** Highest value per unit of
churn.
- `test/fixtures/{mini-flake,broken-flake}` → **root `fixtures/`** — touches
  `tests/common/mod.rs:9` (one line, `CARGO_MANIFEST_DIR/fixtures/mini-flake`),
  `tests/mini_flake.rs:1` comment, `package.nix` `app-test` fileset. Root
  rather than `tests/fixtures/` deliberately: nesting them under `tests/`
  would drag ~13 fixture files into the crate build source once Tier 0 lands,
  coupling fixture edits to dependency-layer rebuilds.
- Remaining `test/` → `web/testing/` if you stop there, or dissolve it in
  Tier 3.

**Tier 2 — `web/` → `web/`.** Cheap and it removes the `src/`-vs-`web/`
ambiguity permanently. Touches `tsconfig.json` include, `typedoc.json`
entryPoints, `package.nix` (`appSrc`, `app-test`), `scripts/build-app.ts` (2
imports + entrypoint), `scripts/bundle-app.ts` (1 import), docs.

**Tier 3 — co-locate `*.test.ts`.** 34 tests → beside their `web/` module,
3 (`licenses`, `page-html`→`build-app`, `release`) → beside their `scripts/`
module. Import churn in 37 files, but mechanical, and the module↔test mapping
becomes structural. Touches `bunfig.toml` preload paths +
`coveragePathIgnorePatterns` (`test/**` → `web/testing/**`), `tsconfig.json`.
`package.nix:102` already filters `*.test.ts` out of the bundle source, so the
Nix build needs no new logic — that filter was written for exactly this.

*If you'd rather keep tests separate:* skip Tier 3 and rename `test/` →
`web-tests/`. Five lines, kills the collision, keeps the flat list.

**Tier 4 — collapse build outputs into `dist/`.**
`app-dist`→`dist/app` (`src/page.rs:39`, `scripts/bundle-app.ts:16`,
`scripts/build-npm.ts:81`), `dist-npm`→`dist/npm` (`build-npm.ts:23`,
`npm-release.yml:102`), `_site`→`dist/site` (`build-docs.ts:36`, `pages.yml`),
`.docs-api`→`dist/api` (`typedoc.json`, `package.json` `docs`),
`coverage`→`dist/coverage` (`bunfig.toml` `coverageDir`, `.octocov.yml`,
`ci.yml`). The published npm layout and the Nix install layout keep the name
`app-dist` — `build-npm.ts:88` already copies to a destination name chosen
independently of the source dir.

Leave alone: `target/` (cargo), `flake-explorer-data/` (a cwd-relative runtime
default, `src/main.rs:36` — correct behaviour that merely happens to land in
the repo when you dev here), `.agents/skills` + the `.claude/skills` symlink
(one skill, two discovery paths — oxc does the same), the two `.octocov*.yml`
(both wired: ci.yml:34 by root discovery, ci.yml:92 explicitly).

## Verification checklist if executed

`bun test` + `cargo test` passing does **not** cover these:
- `nix build .#flake-explorer` and `nix flake check -L` — a stale
  `lib.fileset` entry drops files silently, it does not error.
- `nix eval --raw .#flake-explorer.src.outPath` then `ls` it — confirm `tests/`
  is present after Tier 0.
- `bun run docs` — typedoc `entryPoints` and `build-docs.ts` paths.
- `bun scripts/build-npm.ts --main` then check `dist/npm/flake-explorer/`
  contains `app-dist/app.js` (npm-release.yml:102 asserts this).
- octocov coverage paths in both configs.
- node_modules FOD hash only if `package.json`/`bun.lock` change — a pure
  layout move should not touch it.
