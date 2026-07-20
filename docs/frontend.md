# Frontend

The viewer is a Svelte 5 SPA in [`app/`](../app/App.svelte), written entirely in runes mode and bundled by `Bun.build` with `bun-plugin-svelte` — there is no Vite or separate bundler config; the server builds the bundle in memory at startup ([`src/build-app.ts`](../src/build-app.ts), see [Build & infra](build-and-infra.md)). Entry is [`app/main.ts`](../app/main.ts): it initializes theme, font scale, pane widths, and hash routing on the `app` singleton, kicks off the manifest load, and mounts [`app/App.svelte`](../app/App.svelte). The data it renders is described in [Data schema](data-schema.md).

## State architecture

All state lives in one `AppState` class instance exported as `app` from [`app/lib/state.svelte.ts`](../app/lib/state.svelte.ts). Two rules keep it fast on large flakes:

- **Big payloads are `$state.raw`.** The manifest, per-config data blobs, and file contents are immutable snapshots held in `$state.raw` so Svelte never deep-proxies them; updates replace the whole record (`this.configs = { ...this.configs, [id]: slot }`).
- **Index structures live outside reactivity.** The `ConfigIndexes` / `FlakeIndexes` lookup maps are built once per load in [`app/lib/indexes.ts`](../app/lib/indexes.ts) and swapped in as raw references — they are large and never mutated, so proxying them would be pure overhead.

Loading is modeled as slots: a `ConfigSlot` is `"loading"`, an error object, or `{ data, indexes }`. Errors carry an optional `permanent` flag — in a static export a missing document can never be fetched, so components hide the retry button. Small UI state (search query, expanded sets, hover, tooltip, pane widths, theme) uses plain `$state` and `SvelteSet`.

## Dual data mode

[`app/lib/data.ts`](../app/lib/data.ts) gives static export and serve mode one code path. `loadJson(name)` first looks for an embedded `<script type="application/json" id="data:<name>">` tag; if present its text is parsed, otherwise the document is fetched from `./data/<name>`. `isStatic()` is defined as "does an embedded `manifest.json` tag exist" — a single-file export always embeds the manifest and the serve mode never does (it only embeds `about.json`), so that one tag is the static-mode signal. `hasEmbedded()` lets [`state.svelte.ts`](../app/lib/state.svelte.ts) fail fast with a permanent error when a static export omits a config blob or file source instead of issuing a doomed fetch.

## URL hash deep-linking

[`app/lib/hash.ts`](../app/lib/hash.ts) encodes the current selection as the hash path and view filters behind `?`:

| Form | Selection |
|---|---|
| `#/o/<output.path.dots>` | outputs-tree node (non-module) |
| `#/c/<configId>` | configuration |
| `#/c/<configId>/m/<moduleId>` | module within a configuration |
| `#/c/<configId>/opt/<loc.dots>` | option within a configuration ([`OptionDetail`](../app/components/OptionDetail.svelte)) |
| `#/f/<fileId>` | file |
| `#/i/<inputName>` | flake input |
| `?q=<search>&all=1` | filters: search text, "all options" toggle |

`%`, `?`, and `/` are escaped in every segment; output-path and option-loc segments additionally escape `.` because it is the path separator there. History semantics live in [`state.svelte.ts`](../app/lib/state.svelte.ts): `select()` compares old and new selection with `sameSelection()` — a genuine selection change calls `pushState`, while filter-only changes (and `setFilters`) call `replaceState`, so Back walks selections without replaying keystrokes. `initRouting()` applies the hash at startup and on `hashchange`; a deep link decoded before the manifest arrives is re-followed once `loadManifest()` completes.

## Search

The header box does two things at once: the query keeps live-filtering both trees (`subtreeMatches` label matching, unchanged), and [`SearchBox`](../app/components/SearchBox.svelte) additionally opens a categorized dropdown (Options / Packages / Files / Inputs) built by [`app/lib/search.ts`](../app/lib/search.ts) — pure, unit-tested corpus + ranking (`rankMatch`: exact > exact segment > segment prefix > substring; customized options first). Packages, files, and inputs come from the manifest; options come from *loaded* config blobs (`ConfigIndexes.optionLocsLower`), because they are on-demand documents — the dropdown's footer lists unloaded configurations with a load-in-place button (loading/errored slots render through `AsyncSlot` — error + retry — since `loadConfig` no-ops on an occupied slot). A static export auto-loads every embedded config on first search focus (the blobs are local, so a complete corpus is free); the dynamic server never auto-triggers extraction.

## Supporting modules

| Module | Role |
|---|---|
| [`app/lib/indexes.ts`](../app/lib/indexes.ts) | Pure data-shaping: file identity resolution (self / input / patched-input / unknown), the left-pane module tree, and the O(1) maps behind hover cross-highlighting (`fileToNodes`, `imports`/`importedBy`) |
| [`app/lib/segments.ts`](../app/lib/segments.ts) | Source-view segmentation: unions server-computed tree-sitter highlight runs with client-computed per-line file-reference intervals so one segment can be both colored and a clickable link |
| [`app/lib/color.ts`](../app/lib/color.ts) | Stable colors: first ~12 registered keys get the theme's curated CVD-validated slots (`--s1..--s12`); beyond that FNV-1a hash → golden-angle hue → OKLCH at theme-tuned lightness/chroma |
| [`app/lib/themes.ts`](../app/lib/themes.ts) | The two `THEMES` stops (light/dark warm-paper palettes) as complete CSS custom-property sets applied inline on `:root`, plus the `gen` params color.ts uses for generated colors |
| [`app/lib/url.ts`](../app/lib/url.ts) | Web links for locked inputs: `webUrl()` normalizes `git+https` etc., `commitUrl()` builds per-host commit permalinks (github.com, gitlab.com, codeberg.org) |

## Component map

[`App.svelte`](../app/App.svelte) lays out a header, a three-pane grid with draggable splitters, and overlays. The 18 components in [`app/components/`](../app/components/Stage.svelte) group as:

| Area | Components |
|---|---|
| Chrome | [`Header`](../app/components/Header.svelte), [`SearchBox`](../app/components/SearchBox.svelte) (tree filter + unified results dropdown), [`Splitter`](../app/components/Splitter.svelte), [`Tooltip`](../app/components/Tooltip.svelte) (option hover card), [`AboutModal`](../app/components/AboutModal.svelte) |
| Left pane | [`OutputsTree`](../app/components/OutputsTree.svelte) → [`OutputBranch`](../app/components/OutputBranch.svelte) (generic outputs), [`TreeNode`](../app/components/TreeNode.svelte) (module trees of nixos/darwin configurations) |
| Center pane | [`Stage`](../app/components/Stage.svelte) switches on the selection → [`ModuleDetail`](../app/components/ModuleDetail.svelte), [`FileDetail`](../app/components/FileDetail.svelte), [`InputDetail`](../app/components/InputDetail.svelte), with [`Legend`](../app/components/Legend.svelte) as the no-selection view; shared pieces [`OptionRow`](../app/components/OptionRow.svelte), [`SourceView`](../app/components/SourceView.svelte), [`InputProvenance`](../app/components/InputProvenance.svelte) |
| Right pane | [`FileList`](../app/components/FileList.svelte) → [`FileTreeBranch`](../app/components/FileTreeBranch.svelte) |
| Shared | [`Dot`](../app/components/Dot.svelte) ("the one true dot" — colored marker with optional disclosure triangle), [`tree-connectors.css`](../app/components/tree-connectors.css) |

Cross-highlighting works through the state singleton: hovering a file sets `app.hover`, and `highlightedNodes` / `highlightedFiles` (derived from the precomputed indexes) tint the matching tree nodes in the other panes.

See [Architecture](architecture.md) for how this fits the extractor and server, and [Testing](testing.md) for how components are tested under happy-dom.
