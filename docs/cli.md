# CLI reference

The entry point is [`flake-explorer.ts`](../flake-explorer.ts) (run as `bun flake-explorer.ts`, or via the installed wrapper). A wrapper may set the `FLAKE_EXPLORER_PROG` environment variable so usage and error messages show the invoked name instead of `bun flake-explorer.ts`.

```
usage: flake-explorer <command> [args]

commands:
  extract <flakeref> [--out DIR] [--configs kind/name,... | --all] [--all-systems] [--timeout SECS]
  export <flakeref> [--html FILE] [--out DIR] [--configs kind/name,... | --all] [--all-systems] [--sources self|all] [--timeout SECS]
  serve <flakeref> [--port N] [--out DIR] [--dev]

  --help, -h  Show this help.
```

## Commands

### extract

Extract the manifest (plus any selected configurations) to the data dir, via the shared driver in [`src/extract/drive.ts`](../src/extract/drive.ts). Configurations whose cache sidecar matches (narHash + extractor version) are skipped — see [Extraction pipeline](extraction-pipeline.md). Writes `manifest.json` into `--out`.

### export

Extract, then write **one standalone HTML file** (default `./flake.html`) that works without a server — `file://`, any CDN, GitHub Pages ([`src/export.ts`](../src/export.ts)). The manifest is always embedded; `--configs`/`--all` pick which configurations' options are included. `--sources self` (the default) embeds the flake's own sources and each input's `flake.nix`; `--sources all` also embeds every file the exported configurations reference — against nixpkgs-based systems that means thousands of module sources and a file that can reach tens of MB (GitHub Pages caps a single file at 100 MB; see the size note in the [README](../README.md)).

### serve

Extract the manifest, then serve the explorer UI with on-demand per-configuration extraction ([`src/serve.ts`](../src/serve.ts)). `--dev` watches `app/` and live-reloads connected browsers; run under `bun --watch` to cover server-side files too.

## Flags

Defaults come straight from `parseFlags` in [`flake-explorer.ts`](../flake-explorer.ts) (the `--port` default lives in [`src/serve.ts`](../src/serve.ts)).

| Flag | Default | extract | export | serve | Meaning |
| --- | --- | :-: | :-: | :-: | --- |
| `--out DIR` | `./flake-explorer-data` | yes | yes | yes | Data directory (manifest, config blobs, cache sidecars) |
| `--configs kind/name,...` | none | yes | yes | – | Comma-separated configuration ids, e.g. `nixos/nebula,darwin/k` |
| `--all` | off | yes | yes | – | All configurations (overrides `--configs`) |
| `--all-systems` | off | yes | yes | yes | Pass `--all-systems` to `nix flake show` |
| `--timeout SECS` | `600` | yes | yes | yes | Timeout per nix invocation, seconds (must be a positive number) |
| `--html FILE` | `./flake.html` | – | yes | – | Output path for the standalone HTML file |
| `--sources self\|all` | `self` | – | yes | – | Which source files to embed in the export |
| `--port N` | `4321` | – | – | yes | HTTP port |
| `--dev` | off | – | – | yes | Watch `app/` and live-reload the UI over SSE |

Flag parsing is strict: a missing value, a non-positive number, an unknown flag, or a bad `--sources` value is a hard error rather than a silent default.

## Help and exit codes

- `--help`, `-h`, `help`, or no command at all prints usage and exits `0`. Help is detected anywhere in the arguments (`serve --help` works) before flag parsing runs.
- Usage errors — unknown command, unknown flag, missing flag value, missing `<flakeref>` — print to stderr and exit `1`.

## Flakeref handling

`canonicalRef` in [`flake-explorer.ts`](../flake-explorer.ts) resolves path-like flakerefs through `realpathSync`: nix with lazy-trees disabled refuses a flake root that is itself a symlink, and `/etc/nixos` usually is one. Any `?query` (e.g. `?dir=sub`) is preserved verbatim — it selects a flake, it is not a filesystem path.

## Server HTTP API

All routes are defined in [`src/serve.ts`](../src/serve.ts).

| Route | Method | Behavior |
| --- | --- | --- |
| `/` | GET | The SPA page (built in-memory at startup; rebuilt on change in `--dev`) |
| `/data/manifest.json` | GET | The live manifest (see [Data schema](data-schema.md)) |
| `/data/config/<kind>.<name>.json` | GET | A configuration's options blob. If pending, the request is **held open** while the server extracts it (single-flight per config — concurrent requests share one extraction); `500` with the error message when extraction fails, `404` when the blob is missing |
| `/data/file/<id>?storePath=/nix/store/...` | GET | File source as `{ text, tokens }` with server-side tree-sitter highlight runs. `storePath` is required (`400` otherwise) because option references can point anywhere, e.g. inside nixpkgs; when the path no longer exists, input-origin ids are re-fetched through Nix (`readInputFile`), other ids `404` |
| `/api/refresh` | POST | Re-runs the manifest pass and re-reconciles the cache; responds `{ ok: true }` |
| `/dev/events` | GET | SSE stream that emits `reload` when the UI bundle rebuilds; `404` unless `--dev` |

Anything else is `404`. There is no fixed idle timeout (`idleTimeout: 0`), since extraction-held requests can exceed any bound.
