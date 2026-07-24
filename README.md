# flake-explorer

[![CI](https://github.com/kriswill/flake-explorer/actions/workflows/ci.yml/badge.svg)](https://github.com/kriswill/flake-explorer/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/kriswill/flake-explorer)](https://github.com/kriswill/flake-explorer/releases)
[![Documentation](https://img.shields.io/badge/docs-kris.net-4478bc)](https://kris.net/flake-explorer/docs/)

Interactive visualizer for Nix flakes — built for dendritic
([flake-parts](https://flake.parts) + [import-tree](https://github.com/vic/import-tree))
configurations, works on any flake.

![flake-explorer browsing a NixOS configuration: module tree on the left, portal.nix detail showing input provenance, Configures/Declares with a hover tooltip and syntax-highlighted JSON value, nixpkgs module tree on the right](docs/preview.png)

Three panes:

- **Left — outputs & modules.** Every flake output (`nixosConfigurations`,
  `darwinConfigurations`, `packages`, `overlays`, …). Expanding a
  configuration reveals its module hierarchy: your own module files in their
  directory (mounting) structure, plus per-input subtrees for modules that
  come from flake inputs. Badges count customized options per subtree.
- **Center — detail.** Selecting a module shows **Configures** (option values
  this file sets — with `mkForce`/`mkDefault` priority chips and
  customized-vs-defaulted styling) and **Declares** (options this file
  defines — type, default, current value). Hovering an option shows its type,
  default, priority, and description. Modules from inputs show full
  provenance from `flake.lock` (url, rev, narHash, lastModified).
- **Right — files.** Every `.nix` file the flake references, grouped by
  origin (self first, then inputs). Hovering a file highlights the modules it
  customizes on the left; selecting it shows its last git commit and which
  files import it / it imports.

Selections are deep-linkable (URL hash); light/dark theme; colors are stable
per file/input (curated CVD-safe slots + OKLCH hash colors).

## Documentation

Deeper docs live in [`docs/`](docs/README.md) — architecture, the extractor
pipeline, the data contract, the SPA, testing — rendered at
[kris.net/flake-explorer/docs](https://kris.net/flake-explorer/docs/) with a
generated [API reference](https://kris.net/flake-explorer/docs/api/) alongside
the [live demo](https://kris.net/flake-explorer/) (the explorer browsing its
own flake). Release notes: [CHANGELOG.md](CHANGELOG.md).

## Usage

```console
$ nix run github:kriswill/flake-explorer -- serve /etc/nixos
flake-explorer serving /etc/nixos at http://localhost:4321
```

Or from npm ([@kriswill/flake-explorer](https://www.npmjs.com/package/@kriswill/flake-explorer)) —
a native binary per platform (Linux x64/arm64, macOS arm64); `nix` must
be on PATH either way:

```console
$ npx @kriswill/flake-explorer serve /etc/nixos
$ bunx @kriswill/flake-explorer serve /etc/nixos
```

`serve` extracts the cheap manifest up front and evaluates each
configuration's options **on demand** the first time you open it (cached by
flake narHash; a full NixOS system takes a minute or two the first time).
After editing the flake, `POST /api/refresh` re-scans it (manifest + cache
reconcile) without restarting the server:

```console
$ curl -X POST localhost:4321/api/refresh
```

Pre-extract instead with:

```console
$ flake-explorer extract /etc/nixos --all           # every configuration
$ flake-explorer extract . --configs nixos/myhost   # just one
```

Flags: `--out DIR` (data dir, default `./flake-explorer-data`), `--port N`,
`--all-systems`, `--timeout SECS`.

### Static export

`export` materializes the explorer into **one standalone HTML file** — no
server, no nix, no runtime dependencies. Open it from `file://`, or host it
anywhere static files go (a CDN, GitHub Pages):

```console
$ flake-explorer export /etc/nixos --all            # every configuration
$ flake-explorer export . --configs nixos/myhost --html myhost.html
```

The manifest (outputs, inputs, files, import graph) is always included;
`--configs kind/name,...` / `--all` pick which configurations' options are
embedded (the rest show a "not included in this export" notice). The flake's
own sources and each input's `flake.nix` are embedded by default;
`--sources all` also embeds every file the exported configurations reference
— beware that against nixpkgs-based systems this means thousands of module
sources and a file that can reach tens of MB (GitHub Pages caps a single
file at 100 MB).

This repo publishes its own export on every push to `main` via
[.github/workflows/pages.yml](.github/workflows/pages.yml) —
[flake.html](https://kris.net/flake-explorer/flake.html). To do the
same, copy that workflow and set the repo's Pages source to "GitHub Actions"
(Settings → Pages).

## How it works

- One `extract.nix` evaluated via `nix eval --impure --json` (uses YOUR nix,
  never a vendored one, so store paths and registry match your system).
- Options are walked **chunk-by-chunk** (per top-level namespace, splitting
  failing chunks recursively) because `builtins.tryEval` cannot catch
  missing-attribute/type errors — one poisoned option costs itself, not the
  whole configuration. Values degrade gracefully (full → no values → no
  values+descriptions) and every degradation is surfaced as a warning.
- Customized-vs-default is decided by definition priority
  (`highestPrio < 1500`), not `isDefined` — every option with a default is
  "defined" by its own declaration.
- Files are attributed to inputs by store-path prefix (including transitive
  inputs and patched trees à la `nixpkgs.applyPatches`); your own files get
  per-file `git log` info.

## Development

The extractor/server is a Rust crate at the repo root; the SPA is Svelte 5
(runes) bundled by `Bun.build` + `bun-plugin-svelte` — no Vite. The
extractor emits the JSON contract from `src/schema.rs`; the SPA's
client-side typing of the same contract lives in `app/lib/schema.ts`.

```console
$ nix develop          # cargo + bun + git (plus a live-source `flake-explorer` shim)
$ bun install
$ cargo run -- serve /etc/nixos
$ cargo test           # unit + integration tests (real nix + scripted-nix shims)
$ bun test             # SPA tests (happy-dom)
$ bunx svelte-check --tsconfig ./tsconfig.json
$ nix build            # package: binary + bundled SPA + offline checks
$ bun run docs         # build the docs site into _site/docs
```

## License

MIT
