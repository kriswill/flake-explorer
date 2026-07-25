# Build & infra

How the SPA is bundled, how the CLI ships (Nix and npm), and what CI and GitHub Pages do. See [Architecture](architecture.md) for the runtime picture and [CLI reference](cli.md) for the commands these pipelines invoke.

## App bundling

[`scripts/build-app.ts`](../scripts/build-app.ts) bundles [`web/main.ts`](../web/main.ts) with `Bun.build` + `bun-plugin-svelte` (runes mode) — no Vite. `buildApp()` returns the JS and CSS as strings; `pageHtml()` composes them into a complete single-page HTML shell. Notable details, each documented in the source:

- **Theme CSS is generated, not hand-written.** `themeCss()` renders the default `:root` blocks (light, plus a `prefers-color-scheme: dark` override) from the `THEMES` array in [`web/lib/themes.ts`](../web/lib/themes.ts), so the shell's palette cannot drift from the app's.
- **Embedded data can't break out of its tag.** `jsonTag()` JSON-unicode-escapes every `<`, so `</script` can never occur in the body regardless of the value — file sources contain arbitrary Nix text, including literal `</script>` strings.
- **Whitespace minification stays on even in dev**, because `bun-plugin-svelte` derives Svelte's `preserveWhitespace` from it and preserved whitespace leaks visible text nodes into `white-space: pre` source views.

Serve mode never embeds `manifest.json` — its presence is the client's static-mode signal (see [Frontend](frontend.md) and the exporter in [`src/export.rs`](../src/export.rs)).

## serve --dev

[`src/serve.rs`](../src/serve.rs) composes the page at startup from the prebuilt bundle and, with `--dev`, watches `web/` recursively. A `.svelte`/`.ts`/`.css` change is debounced (150 ms), then re-runs `bun scripts/bundle-app.ts` as a subprocess, reloads `dist/app/`, recomposes the page, and pushes `data: reload` to every browser connected to the `GET /dev/events` server-sent-events route. The client snippet injects reloads on that message — and also on SSE *reconnect*, so restarting the binary after a Rust change reloads the browser as soon as the server comes back.

## Nix packaging

[`flake.nix`](../flake.nix) (flake-parts) exposes `packages.flake-explorer` from [`package.nix`](../package.nix): a crane-built Rust binary plus the bun-built SPA bundle it serves, installed to `$out/share/flake-explorer/app-dist` and symlinked from the binary's runtime probe.

- crane's `buildDepsOnly` compiles the dependency tree as its own derivation keyed only by `Cargo.lock`, so CI rebuilds just this crate on source changes while the dep layer stays in the binary cache.
- `node_modules` is a fixed-output derivation (`bun install --frozen-lockfile`) with a pinned `outputHash`; the lock is pure JS so one hash serves every platform. Refresh procedure is documented next to the hash in [`package.nix`](../package.nix).
- Sources are explicit fileset include-lists, one per derivation. The crate's includes `./tests` so the sandboxed checks actually compile the integration suites; it deliberately excludes `./fixtures` so a fixture edit doesn't invalidate the dep layer. The SPA's excludes `*.test.ts` and `./web/testing` so test edits don't rebuild the bundle.
- `checks.test` is `cargo test` over the crane dep layer; `checks.app-test` is an offline `bun test` against the vendored `node_modules` inside the sandbox (see [Testing](testing.md)).
- `nix` itself is deliberately **not** in the dev shell or wrapper: the CLI must use the host's nix so store paths and the flake registry match the user's system.
- `treefmt` (via treefmt-nix) formats Nix only; Biome owns TS/Svelte through [`biome.json`](../biome.json).

## npm packaging

The repo's `package.json` is not the published manifest — it is marked `private` precisely so it can't be mistaken for one. [`scripts/build-npm.ts`](../scripts/build-npm.ts) stages the publishable layout into `dist/npm/`: one platform package per compiled binary (`@kriswill/flake-explorer-linux-x64` and friends, each just `bin/`), plus the main `@kriswill/flake-explorer` package carrying the launcher and the platform-independent SPA bundle. It writes each package's `package.json` itself — the main one pins the platform packages as `optionalDependencies` at the same version, which the dev workspace deliberately does not carry (they only exist on npm after a release, and listing them would break `bun install --frozen-lockfile`).

[`bin/flake-explorer.mjs`](../bin/flake-explorer.mjs) is the `bin` entry: it resolves the platform package npm kept for the host, then execs that binary with `FLAKE_EXPLORER_APP_DIST` pointed at the bundle shipped alongside it. Inside the published package that bundle sits at `app-dist/` — the historical name, kept because it is a shipped contract, even though a repo checkout builds it to `dist/app/`.

## CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs five jobs on PRs and pushes to main:

| Job | What it does |
|---|---|
| `test typescript` | `bun test --coverage` for the SPA and build scripts; reports coverage via octocov |
| `check typescript` | `bun run lint:ci` (the lockfile's Biome, not `bunx`'s latest), `tsc --noEmit` + `svelte-check`, then `bun run docs` as a smoke check so a broken docs pipeline surfaces on the PR, not on the Pages deploy |
| `nix` | `nix flake check -L` (cargo test/clippy/coverage, the offline SPA test derivation, treefmt) and `nix build .#default`, sharing one nix store |
| `rust-coverage` | `cargo llvm-cov test` **outside** the sandbox with `FLAKE_EXPLORER_REQUIRE_NIX=1` so the real-nix suites run and cannot silently skip; reports the crate's coverage via octocov |
| `build` | Turns `nix` and `rust-coverage` into the pass/fail the ruleset requires, and posts the coverage comment |

Two coverage reports, kept separate so their histories never mix: [`.octocov.yml`](../.octocov.yml) reads `dist/coverage/lcov.info` for the SPA against a fixed `acceptable: 96%` floor, and [`.octocov.rust.yml`](../.octocov.rust.yml) reads `rust-coverage/lcov.info` for the crate as a `current >= prev` ratchet. See [Testing](testing.md).

Each runs octocov in its own job, gates its own job, and reads and writes its own datastore:

| | Title | Datastore artifact |
|---|---|---|
| SPA (`.octocov.yml`) | `Code Metrics Report` | `octocov-report` |
| Crate (`.octocov.rust.yml`) | `Code Metrics Report (rust)` | `octocov-rust` |

The crate's `repository: ${GITHUB_REPOSITORY}/rust` produces both of its cells. It is octocov's monorepo key: it goes into the report title and — the trap — onto the end of the artifact name, which is why `.octocov.rust.yml` names its datastore `octocov` and still reads and writes `octocov-rust`. Change one without the other and the ratchet loses the baseline it compares against, with no visible error.

### One comment, two reports

The PR gets a **single** coverage comment carrying both. octocov cannot produce that itself: it renders one report per invocation and posts it as its own comment, and its only aggregation mode merges several lcov files into one percentage — which would put the crate behind the SPA's floor and bury a crate regression in the much larger TS corpus. (Central mode is not an alternative; it builds an index page and badges for a rollup repository and returns before any comment code runs.)

So the comment is composed rather than delegated. octocov renders the same markdown for the job summary as for a comment, and `OCTOCOV_GITHUB_STEP_SUMMARY` — its documented `OCTOCOV_`-prefixed env override — redirects that markdown to a file in the workspace. Each coverage job replays the file into its real job summary, uploads it as an artifact, and posts nothing. `build`, which already waits on the coverage jobs, downloads both and posts them as one comment under its own `<!-- coverage-report -->` marker, updating that comment in place on every run.

Being the sole writer is what keeps the two suites from clobbering each other. Under the old two-comment arrangement that job fell to octocov's per-report markers; now no producer writes the comment at all, so there is nothing for their finishing order to race over.

`build` runs under `if: always()`, so it sees failed dependencies by design. A suite whose job died before octocov ran uploads nothing, and its section becomes a warning naming the job and its result rather than a blank or a stale number — a failing `nix` job cannot empty a coverage section, because `nix` measures no coverage. When neither suite reported and there is no existing comment to correct, nothing is posted at all.

## GitHub Pages

[`.github/workflows/pages.yml`](../.github/workflows/pages.yml) publishes on pushes to main:

1. `nix run .# -- export . --all --sources all --html dist/site/flake.html` — a single-file static export of this repo's own flake as the live demo; `index.html` is a copy so the site root works.
2. `bun run docs` — `typedoc` (via `typedoc-plugin-markdown` into `dist/api`), then `bun scripts/build-docs.ts --out dist/site/docs --api dist/api`.

Resulting site layout: `/` is the demo, `/docs/` renders these pages, `/docs/api/` is the generated API reference. [`scripts/build-docs.ts`](../scripts/build-docs.ts) converts `docs/*.md` with marked into a shared shell styled by the same `themeCss()` as the app; mermaid is bundled locally from the [`scripts/docs-mermaid-client.ts`](../scripts/docs-mermaid-client.ts) entry (no CDN) and included only on pages containing a mermaid fence. Links out of `docs/` (e.g. `../src/schema.rs`) are rewritten to the GitHub blob view.

## Docs workflow for contributors

Edit `docs/*.md` directly — GitHub renders them natively, including mermaid fences, so the markdown must stand on its own. Pages are registered in the ordered `PAGES` nav list in [`scripts/build-docs.ts`](../scripts/build-docs.ts); `README.md` becomes `index.html`. Run `bun run docs` to build the full site locally into `dist/site/docs` (CI runs the same command).
