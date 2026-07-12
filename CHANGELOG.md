# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.3] — 2026-07-12

### Fixed

- The file map no longer picks up `.nix` files from nested repositories and
  git worktrees (e.g. an untracked `.claude/worktrees/*` inside the flake
  dir). Under lazy-trees (Determinate Nix) the flake "source" is the working
  directory itself, so the extractor's walk saw untracked clutter; any
  non-root directory carrying its own `.git` is now skipped wholesale.

## [0.1.2] — 2026-07-12

### Fixed

- npm installs (`bunx`, `npx`, `npm install`) failed on every nix-touching
  command: the `nix eval` expression embedded the extract.nix path as a bare
  Nix path literal, which cannot contain the `@` that scoped-package install
  paths (`node_modules/@kriswill/…`) always carry — nor spaces. The path is
  now passed as a quoted Nix string.

## [0.1.1] — 2026-07-12

### Added

- Curated documentation under [`docs/`](docs/README.md), published to the
  Pages site at <https://kris.net/flake-explorer/docs/> alongside the demo,
  including a CI-generated TypeDoc API reference for the data contract
  (`src/schema.ts`).
- `--help` / `-h` flag (and `help` command): usage on stdout, exit 0.
  Unknown commands now report to stderr with exit 1.
- Docs site: license notices for the bundled mermaid asset — the full
  dependency closure ships as `docs/licenses.html`, linked from every page
  that loads the bundle.
- Release workflow (`Release`, manually dispatched with major/minor/patch):
  bumps `package.json` (the single version source — `package.nix` reads it at
  eval time), rolls this changelog, tags `vX.Y.Z`, and publishes a GitHub
  release with the section as notes.
- README badges: CI status, latest release, documentation.
- npm publishing: the release workflow publishes
  [`@kriswill/flake-explorer`](https://www.npmjs.com/package/@kriswill/flake-explorer)
  via OIDC trusted publishing, so `bunx @kriswill/flake-explorer serve .`
  works without cloning.
- This changelog.

## [0.1.0] — 2026-07-10

### Added

- Initial three-pane explorer: flake outputs & module hierarchy (left),
  module detail with Configures/Declares and option provenance (center),
  referenced files grouped by origin (right).
- `extract` command: manifest plus per-configuration options extraction to a
  data directory, cached by flake narHash.
- `serve` command: explorer UI with on-demand per-configuration extraction
  and `POST /api/refresh` re-scanning; `--dev` watches `app/`, rebuilds
  in-memory, and live-reloads the browser over SSE.
- `export` command: ONE standalone HTML file (data embedded) that works from
  `file://`, any CDN, or GitHub Pages; `--sources self|all` controls embedded
  source files. Pages workflow publishes this repo's own flake as a demo.
- Tree-sitter Nix syntax highlighting with clickable reference links.
- Input provenance from `flake.lock` with url/rev linked to their web host.
- File list as a folder tree with auto-reveal, filtering, and origin cards;
  resizable panes; font-size control; About modal with license notices.
- npm `bin/flake-explorer.mjs` launcher.

### Changed

- Schema cleanup: versioned blobs, dead serialized fields dropped,
  config-name sanitization.
- Shared cached extraction driver with flag validation.
- Adopted Biome (format, lint, ASI style) and treefmt-nix for Nix files.

### Fixed

- Lazy-trees path attribution.
- Refresh race in the extraction driver.
- Nix timeouts no longer rely on AbortSignal identity.
- Output names containing dots round-trip in deep links.

### Infrastructure

- CI guardrails: tests with a coverage ratchet (78% → 97% line coverage),
  typecheck, Biome lint, `nix flake check`, Dependabot.

[Unreleased]: https://github.com/kriswill/flake-explorer/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/kriswill/flake-explorer/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/kriswill/flake-explorer/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/kriswill/flake-explorer/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/kriswill/flake-explorer/releases/tag/v0.1.0
