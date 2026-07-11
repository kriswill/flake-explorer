# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/kriswill/flake-explorer/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/kriswill/flake-explorer/releases/tag/v0.1.0
