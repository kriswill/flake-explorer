# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] — 2026-07-24

### Changed

- The program — CLI, extractor, HTTP server, and static exporter — is now
  a single native Rust binary instead of a bun-run TypeScript tree. The
  JSON data contract is unchanged and 0.4.x data directories keep
  working: extraction output was verified field-for-field against the
  previous implementation on real flakes (this repo, a 57-input dotfiles
  flake, and a full 15,436-option NixOS configuration). The one visible
  effect is a new `rs-` extractor fingerprint, so existing cached blobs
  re-extract once on next access.
- The npm package now ships per-platform native binaries — Linux and
  macOS, x64 and arm64 — installed via `optionalDependencies` and
  resolved by a Node >= 20 launcher that also points the binary at the
  SPA bundle shipped in the main package. bun is no longer a runtime
  requirement: `npx @kriswill/flake-explorer` works as well as `bunx`.
  (`nix` on PATH is still required at runtime.)

### Added

- The flake package (`nix run`) installs the native binary together with
  the SPA bundle, so the explorer works out of the box without a
  JavaScript runtime on the host.
- A cargo test suite, including integration tests that drive real `nix`
  against fixture flakes (extraction, serve routes, degradation paths,
  static export), with its own coverage gate in CI alongside the
  existing SPA suite's.

### Fixed

- Static exports preserve explicit `null` option values instead of
  silently dropping them.
- Options whose `defaultText` is a non-string scalar (nixpkgs'
  bluesky-pds sets `false`) no longer derail extraction — scalars are
  rendered as their literal text.
- Component tests no longer crash order-dependently after the serve
  suite: the serve tests now swap in only Bun's native network globals
  for their duration instead of replacing the whole happy-dom realm,
  which invalidated Svelte's cached document state (#74).

### Removed

- The TypeScript implementation of the program (CLI, extractor, server,
  exporter) — the Svelte SPA and its bun toolchain remain.
- `web-tree-sitter` and its WASM grammars: syntax highlighting is native
  tree-sitter with token output verified identical.

## [0.4.0] — 2026-07-21

### Added

- Transitive inputs are walkable end to end: the sidebar's inputs section
  gains a collapsed "transitive" disclosure listing every deduped lock
  node as a selectable `parent/child` page, search surfaces them with a
  "transitive" tag (ranked just behind direct inputs at equal match
  quality), and the flake overview splits the closure into honest
  counts — walkable transitive nodes vs `follows` edges, which are
  aliases onto existing nodes rather than nodes of their own.
- An overlay page lists the top-level attrs its body adds or overrides:
  the source scan locates each overlay's `final: prev: { … }` body
  (inline, or the imported file when the definition is `import
  ./file.nix`), enumerates its depth-1 attrs, and marks each add vs
  override (an attr redefining the same-named `prev`/`super` package). An
  attr re-exposed as a flake package links to that package's page;
  unscannable bodies (anonymous, computed, or `let … in` forms) get an
  honest in-page note instead of a wrong guess.
- A package page answers "what in this flake depends on this?": a
  "Depended on by" section joined on `drvPath` — false-positive-free, two
  derivations never share a `.drv` path. Static exports embed an
  authoritative reverse-deps index over the exported set; serve mode
  derives one over packages loaded this session, labels its scope
  honestly, and offers to load the rest to complete the count.

### Changed

- The overlay definition-site scan's schema grew per-overlay attr lists,
  so existing cached blobs re-extract once on next access.

### Fixed

- Hand-typed deep links with a raw `/` inside a file/input/config id
  (`#/f/self:pkgs/rtk.nix`) now resolve — the hash parser rejoins the
  remainder for single-id routes instead of truncating to a nonexistent
  id and hanging. A genuinely unresolvable id renders an explicit
  "Unknown file" page.
- Cold deep links to files reached only through option declarations
  (e.g. a nixpkgs module) rebuild their store path from the input's
  `storePath` and load their source instead of showing a permanent
  loading state.
- Transitive inputs no longer hide their "Modules contributed" section
  before any configuration is loaded — they genuinely contribute modules,
  and the load affordance is now uniform with direct inputs.

## [0.3.0] — 2026-07-20

### Added

- Package- and derivation-typed options no longer skip their value
  wholesale: a names-only forcing path extracts each derivation's name
  (merged value, default, and per-definition), so
  `environment.systemPackages` finally answers "what does this module
  install?". Names render in option rows and option pages, capped with an
  honest overflow marker. The module system's ", via option <path>"
  provenance is captured as structured data instead of being discarded,
  and a definition-site scan records where each `overlays.<name>` is
  defined.
- Overlays and `flake.modules.*` outputs have real pages instead of
  dead-ending: an overlay page shows its type, defining file, and who
  imports that file; module-output pages route through the via-provenance
  stamps to the files that consume the module in each configuration, with
  declared/set option counts and load-in-place for unloaded
  configurations. Checks, devShells, and the formatter get a role badge
  next to the builder badge on their package pages.
- Deep links restore context, not just content: the left module tree now
  expands and scrolls to the selection (previously only the right file
  tree revealed), breadcrumbs across module/file/option pages, and a
  `?L=<line>` param links an option's declaration line into the file
  source view, highlighted and scrolled into view.
- Two-configuration option diff view at `#/diff/<a>/<b>`: one row per
  option customized on either side (only-a / only-b / differs / equal /
  incomparable), package-typed options compared by their drv names,
  per-side load-in-place, `?q=` filtering, and a 500-row cap with an
  honest overflow note. Entry points: "compare with" links on the config
  landing page and per-row "diff" links on option pages.
- The config landing page shows a summary — most-customized areas,
  modules by input, compare links — instead of a one-line count. The file
  list gains an "only contributing files" toggle (`?contrib=1`), and
  directory nodes in the module tree are labeled with a trailing `/` like
  the file tree's.

### Changed

- Data ingestion validates blobs at runtime (`isManifest`,
  `isConfigData`, `isPackageData`) instead of casting: a truncated or
  foreign blob now fails with a clear error rather than a bare TypeError
  deep inside index building, while forward-compatible blobs with extra
  fields still load.
- The extractor fingerprint changed with the new extraction features, so
  existing cached config blobs re-extract once on next access.

### Fixed

- A transitive input that cannot be resolved (e.g. a FlakeHub pin whose
  lock entry url disagrees with what the fetcher returns) no longer takes
  the whole manifest down: extraction retries with direct inputs only and
  records a warning naming the nix error. Every input is still listed
  from the lock graph; only option files living inside a transitive input
  fall back to the "unknown" bucket.
- Output deep links (`#/o/…`) scroll the revealed leaf into view.
- The drv-name extractor's large-attrset bail reports `«attrs:N»` instead
  of an empty list indistinguishable from "no packages".
- Consecutive blank source lines no longer collapse into stacked gutter
  line numbers.
- `jsonSegments` now matches `JSON.stringify(v, null, 2)` for undefined
  array slots and undefined-valued object keys, as its contract states.

### Security

- The serve `/data/file/` route accepted any absolute path and returned
  any file the serving user could open, and the server bound 0.0.0.0 by
  default. Reads are now confined to the nix store and the flake's own
  tree (normalized, so `..` cannot climb out and `/nix/store-evil` cannot
  pass as the store), and the server binds 127.0.0.1 unless `--host` says
  otherwise.

### Infrastructure

- The test suite grew from 422 to 565 tests: on-demand package
  extraction, the transitive-input degradation path, the diff view, tree
  components, and the overlay/input-ref/import scans are now exercised in
  the sandboxed (shimmed-nix) run.

## [0.2.0] — 2026-07-20

### Added

- Rich detail page for derivation-typed outputs — packages, devShells,
  checks, and formatter. Click one in the outputs tree to see builder kind
  (rustPlatform/buildGoModule/node/trivial/stdenv/unknown), pname/version,
  meta (license, homepage, platforms, maintainers, position), source
  fetcher, build phases, declared + drv-level dependencies, outputs, and
  runtime closure size when the output is already in the local store.
  Extracted on demand, same lifecycle as configuration options; new
  `--packages id,...` CLI flag (`--all` now covers packages too).
- Packages appear on the page of the file that defines them (reverse lookup
  from `meta.position`), with two-way title-row chips linking a package and
  its defining file. Build-phase scripts are syntax-highlighted through a
  vendored tree-sitter-bash grammar.
- Options have a first-class page — `#/c/<config>/opt/<option.path>` —
  showing type, priority, description, declared-in with `file:line`,
  definitions in merge order with priority chips, the final merged value,
  and the same option across other configurations. Option names link there
  from module pages, file pages, and search.
- Richer option provenance in the extracted data: declaration line/column
  (via the module system's `declarationPositions`), per-definition
  priority, an explicit "(value skipped)" marker instead of inference, and
  a scan of which self files reference each input.
- Input pages answer "where is this consumed?": files referencing the
  input, modules it contributes per configuration (with load-in-place
  buttons), outputs grafted from it (`lib = nixpkgs.lib.extend …`), and its
  own inputs — including follows edges the lock-graph dedup previously
  dropped. The landing page splits the input count into direct +
  transitive.
- Unified search: the header box still live-filters both trees, and now
  also opens a categorized dropdown (Options / Packages / Files / Inputs)
  with keyboard navigation and ranked matches (exact > exact segment >
  segment prefix > substring; customized options first). Options come from
  loaded configurations — the footer lists unloaded ones with a
  load-in-place button, and static exports auto-load their embedded
  configs on first search focus.

### Changed

- The extraction cache key is now fully content-derived: a SHA-256
  fingerprint over the extractor sources replaces the hand-bumped
  `EXTRACTOR_VERSION`, the flake identity falls back to the self store
  path for dirty checkouts (source edits now invalidate), and an
  order-independent hash of the resolved input set catches input drift.
  Existing cached sidecars re-extract once on next access.

### Fixed

- The serve blob route now 404s data files the manifest doesn't claim:
  previously sidecar metadata was served verbatim, and an encoded `../`
  could escape the data directory (read-only, `.json`-limited).
- The left tree's documented input ordering (self entries first, nixpkgs
  last) was being discarded by a later alphabetical sort; it now renders
  as documented.

### Infrastructure

- Hermetic test coverage for the extraction pipeline's core (manifest
  lock-graph traversal, options chunk-split ladder, serve routes) via a
  scripted `nix` PATH shim; the suite grew from 294 to 422 tests.

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

[Unreleased]: https://github.com/kriswill/flake-explorer/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/kriswill/flake-explorer/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/kriswill/flake-explorer/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/kriswill/flake-explorer/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/kriswill/flake-explorer/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/kriswill/flake-explorer/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/kriswill/flake-explorer/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/kriswill/flake-explorer/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/kriswill/flake-explorer/releases/tag/v0.1.0
