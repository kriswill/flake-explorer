# Build & infra

How the SPA is bundled, how the CLI ships (Nix and npm), and what CI and GitHub Pages do. See [Architecture](architecture.md) for the runtime picture and [CLI reference](cli.md) for the commands these pipelines invoke.

## App bundling

[`src/build-app.ts`](../src/build-app.ts) bundles [`web/main.ts`](../web/main.ts) with `Bun.build` + `bun-plugin-svelte` (runes mode) — no Vite. `buildApp()` returns the JS and CSS as strings; `pageHtml()` composes them into a complete single-page HTML shell. Notable details, each documented in the source:

- **Theme CSS is generated, not hand-written.** `themeCss()` renders the default `:root` blocks (light, plus a `prefers-color-scheme: dark` override) from the `THEMES` array in [`web/lib/themes.ts`](../web/lib/themes.ts), so the shell's palette cannot drift from the app's.
- **Embedded data can't break out of its tag.** `jsonTag()` JSON-unicode-escapes every `<`, so `</script` can never occur in the body regardless of the value — file sources contain arbitrary Nix text, including literal `</script>` strings.
- **Whitespace minification stays on even in dev**, because `bun-plugin-svelte` derives Svelte's `preserveWhitespace` from it and preserved whitespace leaks visible text nodes into `white-space: pre` source views.

Serve mode never embeds `manifest.json` — its presence is the client's static-mode signal (see [Frontend](frontend.md) and the exporter in [`src/export.ts`](../src/export.ts)).

## serve --dev

[`src/serve.ts`](../src/serve.ts) builds the page in memory and, with `--dev`, watches `web/` recursively. A `.svelte`/`.ts`/`.css` change triggers a debounced in-memory rebuild, then pushes `data: reload` to every browser connected to the `GET /dev/events` server-sent-events route. The client snippet `pageHtml()` injects reloads on that message — and also on SSE *reconnect*, which covers server-side `.ts` changes: those are `bun --watch`'s job (the process restarts, the connection drops, the client reloads when it comes back).

## Nix packaging

[`flake.nix`](../flake.nix) (flake-parts) exposes `packages.flake-explorer` from [`package.nix`](../package.nix). Because `serve` bundles the SPA at CLI runtime, `bun build --compile` is out — the package ships the TypeScript tree plus vendored `node_modules` and a bun wrapper:

- `node_modules` is a fixed-output derivation (`bun install --frozen-lockfile`) with a pinned `outputHash`; the lock is pure JS so one hash serves every platform. Refresh procedure is documented next to the hash in [`package.nix`](../package.nix).
- Sources are an explicit fileset include-list; tests are excluded from the shipped package because bun's test scanner follows the `result` symlink and would run a stale second copy of the suite.
- `checks.test` is `cargo test` over the crane dep layer; `checks.app-test` is an offline `bun test` against the vendored `node_modules` inside the sandbox (see [Testing](testing.md)).
- `nix` itself is deliberately **not** in the dev shell or wrapper: the CLI must use the host's nix so store paths and the flake registry match the user's system.
- `treefmt` (via treefmt-nix) formats Nix only; Biome owns TS/Svelte through [`biome.json`](../biome.json).

## npm packaging

The repo's `package.json` is not the published manifest. [`scripts/build-npm.ts`](../scripts/build-npm.ts) stages the publishable layout into `dist/npm/`: one platform package per compiled binary (`@kriswill/flake-explorer-linux-x64` and friends, each just `bin/`), plus the main `@kriswill/flake-explorer` package carrying the launcher and the platform-independent SPA bundle. It writes each package's `package.json` itself — the main one pins the platform packages as `optionalDependencies` at the same version, which the dev workspace deliberately does not carry (they only exist on npm after a release, and listing them would break `bun install --frozen-lockfile`).

[`bin/flake-explorer.mjs`](../bin/flake-explorer.mjs) is the `bin` entry: it resolves the platform package npm kept for the host, then execs that binary with `FLAKE_EXPLORER_APP_DIST` pointed at the bundle shipped alongside it. Inside the published package that bundle sits at `app-dist/` — the historical name, kept because it is a shipped contract, even though a repo checkout builds it to `dist/app/`.

## CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs three jobs on PRs and pushes to main:

| Job | What it does |
|---|---|
| `test typescript` | `bun test --coverage` for the SPA and build scripts; uploads coverage via octocov |
| `check typescript` | `bun run lint:ci` (the lockfile's Biome, not `bunx`'s latest), `tsc --noEmit` + `svelte-check`, then `bun run docs` as a smoke check so a broken docs pipeline surfaces on the PR, not on the Pages deploy |
| `build` | `nix flake check -L` (cargo test/clippy/coverage, the offline SPA test derivation, treefmt), `nix build .#default`, then `cargo llvm-cov test` **outside** the sandbox with `FLAKE_EXPLORER_REQUIRE_NIX=1` so the real-nix suites run and cannot silently skip; uploads the crate's coverage via octocov |

Two coverage reports, kept separate so their histories never mix: [`.octocov.yml`](../.octocov.yml) reads `dist/coverage/lcov.info` for the SPA against a fixed `acceptable: 96%` floor, and [`.octocov.rust.yml`](../.octocov.rust.yml) reads `rust-coverage/lcov.info` for the crate as a `current >= prev` ratchet. See [Testing](testing.md).

## GitHub Pages

[`.github/workflows/pages.yml`](../.github/workflows/pages.yml) publishes on pushes to main:

1. `nix run .# -- export . --all --sources all --html dist/site/flake.html` — a single-file static export of this repo's own flake as the live demo; `index.html` is a copy so the site root works.
2. `bun run docs` — `typedoc` (via `typedoc-plugin-markdown` into `dist/api`), then `bun scripts/build-docs.ts --out dist/site/docs --api dist/api`.

Resulting site layout: `/` is the demo, `/docs/` renders these pages, `/docs/api/` is the generated API reference. [`scripts/build-docs.ts`](../scripts/build-docs.ts) converts `docs/*.md` with marked into a shared shell styled by the same `themeCss()` as the app; mermaid is bundled locally from the [`scripts/docs-mermaid-client.ts`](../scripts/docs-mermaid-client.ts) entry (no CDN) and included only on pages containing a mermaid fence. Links out of `docs/` (e.g. `../src/schema.ts`) are rewritten to the GitHub blob view.

## Docs workflow for contributors

Edit `docs/*.md` directly — GitHub renders them natively, including mermaid fences, so the markdown must stand on its own. Pages are registered in the ordered `PAGES` nav list in [`scripts/build-docs.ts`](../scripts/build-docs.ts); `README.md` becomes `index.html`. Run `bun run docs` to build the full site locally into `dist/site/docs` (CI runs the same command).
