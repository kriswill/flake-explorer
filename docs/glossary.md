# Glossary

Project-specific terms, alphabetical. Each links to the source that defines it.
See also [Architecture](architecture.md) and [Data schema](data-schema.md).

**Chunk walk** — The option tree is evaluated in chunks (an option path plus an
optional child subset), one `nix eval` per chunk; a failing chunk is halved or
descended at the same detail level to isolate the poisoned option, so healthy
siblings keep full values ([`src/extract/options.ts`](../src/extract/options.ts)).

**Config blob / `ConfigData`** — The expensive per-configuration JSON document
(`config/<kind>.<name>.json`): all `OptionEntry` records plus a precomputed
`fileIndex` so the SPA never scans thousands of options per click
([`src/schema.ts`](../src/schema.ts)).

**Customized vs defaulted** — An option counts as customized when
`isDefined && highestPrio < 1500`, i.e. a real definition beat the option's own
declared default — not `isDefined` alone, since every option with a default is
"defined" by its own declaration ([`src/schema.ts`](../src/schema.ts)).

**Degradation ladder** — The three detail levels a failing, unsplittable chunk
walks down: full → values skipped → values+descriptions skipped, each rung
surfaced as a warning before the chunk is abandoned
([`src/extract/options.ts`](../src/extract/options.ts)).

**Dendritic** — A flake-parts + import-tree configuration style where every
`.nix` file is a flake-parts module discovered by directory structure; the
pattern flake-explorer is optimized for ([README](../README.md)).

**Direct vs transitive input** — Root-level `flake.lock` inputs vs
inputs-of-inputs; transitive inputs carry `transitive: true`, are named
`parent/child`, and are deduped so a followed input appears once
([`src/schema.ts`](../src/schema.ts), built in
[`src/extract/manifest.ts`](../src/extract/manifest.ts)).

**flake-parts** — The module framework (<https://flake.parts>) this project
both targets as a visualization subject and uses for its own
[`flake.nix`](../flake.nix).

**Follows** — flake.lock's input aliasing (`inputs.x.inputs.nixpkgs.follows`):
`InputInfo.follows` records the followed node key, resolved by walking the lock
graph ([`src/schema.ts`](../src/schema.ts),
[`src/extract/manifest.ts`](../src/extract/manifest.ts)).

**Graft / `GraftInfo`** — A top-level output detected as extending an input's
same-named namespace (e.g. `lib = nixpkgs.lib.extend …`), flagged when >=90% of
the input's attr names reappear; the UI shows only the `added` keys and hides
the inherited bulk ([`src/schema.ts`](../src/schema.ts)).

**import-tree** — <https://github.com/vic/import-tree>, the auto-importer that
mounts every `.nix` file under a directory as a module; half of the dendritic
pattern ([README](../README.md)).

**Manifest** — The cheap, always-regenerated document (`manifest.json`): flake
metadata, outputs tree, inputs, file list, import graph, configuration refs,
grafts, and warnings ([`src/schema.ts`](../src/schema.ts), built in
[`src/extract/manifest.ts`](../src/extract/manifest.ts)).

**Mounting structure** — The left pane shows a configuration's own module files
in their directory layout — where import-tree "mounts" them — rather than as a
flat list; the tree is shaped client-side in
[`app/lib/indexes.ts`](../app/lib/indexes.ts) ([README](../README.md)).

**narHash** — The content hash of the locked flake tree; the cache key that
decides whether a config blob is still fresh, recorded in each sidecar
alongside the extractor version ([`src/extract/cache.ts`](../src/extract/cache.ts)).

**Priority / `mkForce` / `mkDefault`** — `lib.mkOverride` definition
priorities; the well-known values live in `PRIO` (mkForce 50, plain 100,
mkDefault 1000, option default 1500) and drive the priority chips and
customized styling ([`src/schema.ts`](../src/schema.ts)).

**Sidecar** — The `config/<kind>.<name>.meta.json` file next to each config
blob, recording narHash, extractor version, timestamp, option count, duration,
and warnings; `reconcile` flips matching configs to "ok" so they are not
re-evaluated ([`src/extract/cache.ts`](../src/extract/cache.ts)).

**Single-flight extraction** — `serve` extracts a pending configuration at most
once concurrently: the first request triggers extraction and is held open,
later requests for the same config await the same in-flight promise
([`src/serve.ts`](../src/serve.ts)).

**Store path** — An absolute `/nix/store/...` path. Files are attributed to
inputs by store-path prefix match against each input's `outPath`; lazy trees
are disabled so paths are real and comparable across evals
([`src/extract/run-nix.ts`](../src/extract/run-nix.ts),
[`src/extract/manifest.ts`](../src/extract/manifest.ts)).

**storePath join key** — The universal join between the two documents:
`FileEntry.storePath` matches the file strings in an option's
`declarations`/`definitions`, letting the SPA connect files to options
([`src/schema.ts`](../src/schema.ts)).

**`UNKNOWN_FILE` sentinel** — The `"<unknown-file>"` string the module system
uses for inline/anonymous modules; it appears as a file key in
declarations, definitions, and the `fileIndex`
([`src/schema.ts`](../src/schema.ts)).
