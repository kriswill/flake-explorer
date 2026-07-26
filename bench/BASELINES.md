# Extraction baselines

Numbers produced by [`scripts/bench-extract.ts`](../scripts/bench-extract.ts), kept here so a
later change can be compared against something rather than against a memory.

To re-record, run the harness and paste its markdown under the two headings below — it prints a
report, it does not edit this file:

```sh
bun scripts/bench-extract.ts ./fixtures/mini-flake --runs 5 --warm-runs 5
bun scripts/bench-extract.ts ~/src/github/kriswill/dotfiles --label dotfiles --runs 2 --warm-runs 3
```

## How to read these

- **cold** = a fresh `--out` directory: no sidecar is reusable, so every configuration and package
  is extracted again. It is **not** a cold machine. Nix's eval cache and store stay warm, and they
  matter more than the extractor does: the same mini-flake extraction measured 4.4s against a cold
  eval cache and 0.75s against a warm one. Compare a cold leg only against another cold leg taken
  the same way.
- **warm** = the second run against the directory cold left behind. Every blob reconciles, so this
  leg is the manifest pass plus cache reconciliation and nothing else.
- **phases** come from `FLAKE_EXPLORER_TIMINGS=1` (see [`src/timing.rs`](../src/timing.rs)) and are
  per-phase medians across the leg's runs. They are medians of different runs, so they need not sum
  to the median total — read them as a shape, not as an accounting.
- **load average** is the machine's 1-minute load when each run ended. These baselines were taken on
  a shared machine with other work in flight; a leg taken at load 7 on 24 cores is usable for
  comparison but is not a quiet-machine number.
- **peak RSS** means two different things below, and the difference is large enough to change
  conclusions. GNU `time -v` reports `ru_maxrss` from `RUSAGE_CHILDREN`, which is **the largest
  single child**, not the sum — for an extractor whose memory lives in N concurrent `nix`
  processes, that answers the wrong question. Rows marked *tree* come from
  [`scripts/tree-rss.ts`](../scripts/tree-rss.ts), which walks `/proc` and sums the whole process
  tree, reporting both RSS (shared pages counted per process) and PSS (shared pages divided).
- **A/B rows are interleaved**, not batched by arm: rep 1 runs old-then-new, rep 2 new-then-old, so
  drift over the session lands on both arms. Every heavy leg holds the team's exclusive lock, since
  two agents measuring this flake at once contaminated an earlier sweep in both directions.

## Machine

| | |
|---|---|
| Cores | 24 (`nproc`) |
| Platform | linux/x64 |
| Nix | `nix (Determinate Nix 3.21.5) 2.34.8` |
| hyperfine | not installed (the harness times in-process; see the script header) |
| Commit | mini-flake `84c1ddc`, dotfiles `c45eb23` — both `perf/bench-harness`, both functionally `00f6a4b` plus opt-in timing. The commits differ only in the harness's contention check, so the binary measured is the same one |
| Date | 2026-07-26 |

## Where the numbers have moved

Dotfiles `extract --all`, cold, on this machine:

| code | cold wall | peak memory | what changed |
| --- | ---: | ---: | --- |
| `84c1ddc` (v0.5.1 + timing) | 146.2s | 5.9 GiB (largest child) | serial packages, serial configurations |
| `bd324da` (concurrent units) | 94.8s | 10.6 GB (tree RSS) | configurations and packages as one set of concurrent futures |
| `2669eaf` (batched chunks) | 92.1s | 12.5 GB (tree RSS) | option chunks sent to `nix` in batches |

The memory column is not directly comparable across the first two rows — the first is the largest
single `nix` process, the second is the whole tree — which is exactly why the tree sampler exists.
The single-config numbers below are where batching actually pays.

## Current: `~/src/github/kriswill/dotfiles`

Two reps per arm, interleaved, each leg under the exclusive lock. `bd324da` is main; `2669eaf` is
the batched-chunks branch. 123 files, 57 inputs, 1 NixOS configuration (`nixos/nebula`, 15,436
options), 18 packages. Neither arm degraded; both produced 14 warnings.

### `extract --all`

| arm | leg | wall | CPU | peak tree RSS | peak tree PSS |
| --- | --- | ---: | ---: | ---: | ---: |
| `bd324da` main | cold | 95.04s / 94.50s | 704% / 704% | 10.64 GB / 10.60 GB | 10.49 GB / 10.14 GB |
| `2669eaf` batch | cold | 92.30s / 91.97s | 728% / 720% | 13.09 GB / 11.84 GB | 12.85 GB / 11.68 GB |
| `bd324da` main | warm | 0.73s / 0.81s | 119% / 118% | 211 MB / 175 MB | 193 MB / 156 MB |
| `2669eaf` batch | warm | 0.77s / 0.88s | 120% / 117% | 243 MB / 234 MB | 226 MB / 216 MB |

Phase split on the cold leg (`FLAKE_EXPLORER_TIMINGS=1`): main options 94.3s / packages 36.1s;
batch options 91.4s / packages 38.6s. The manifest pass is 0.7–0.9s either way.

**−2.8% wall for +11…23% peak memory.** The option-batching win is largely absorbed here because
the package pass runs concurrently and the machine is already near its CPU ceiling — 704% before,
728% after.

### One configuration, options only

The path `serve` takes when a user opens a configuration and waits for it. No package pass, no
manifest pass — measured with [`examples/options-probe.rs`](../examples/options-probe.rs), which
also bypasses the sidecar cache, so every run is cold.

| arm | wall | CPU | peak tree RSS | peak tree PSS | chunk evals |
| --- | ---: | ---: | ---: | ---: | ---: |
| `bd324da` main | 78.94s / 72.20s | 687% / 713% | 11.40 GB / 12.26 GB | 11.26 GB / 12.12 GB | 348 / 348 |
| `2669eaf` batch | 59.74s / 59.37s | 790% / 840% | 6.97 GB / 7.68 GB | 6.78 GB / 7.46 GB | 331 / 328 |

**−21% wall AND −39% peak memory**, with identical output (15,436 options, 14 warnings on both).
This is where batching pays, and it is the user-facing path.

Read the two tables together: nothing about batching makes an evaluation heavier — in isolation it
makes the whole pass substantially lighter. The `--all` memory increase is therefore an overlap
effect, batched option evals coinciding with package evals, not a per-eval cost. (Mechanism stated
as a hypothesis; what is measured is the two tables.)

### Data fidelity

All 45 files in the data directory are identical between arms, modulo `durationMs`, `extractedAt`,
`generatedAt` and `extractor`. The first three vary between any two runs of the same binary; the
fourth is the extraction fingerprint, which must move because the branch changes `crates/extract`.
Config and package **blobs are byte-identical**. A strict same-arm control (main rep 1 vs main rep 2)
passes without the fingerprint exemption.

## Current: `fixtures/mini-flake`

Two reps per arm, `extract --all`. Both arms: **0.20s cold, 0.067s warm** — parity, as expected
where one configuration and five packages leave nothing to batch. Data directories identical across
arms on the same terms as above (13 files).

Memory is not quoted for this flake: at 200ms sampling a 200ms run yields one or two samples, which
is not a peak. Sub-second commands need `--interval 25` or smaller before their memory means
anything.

## History: fixtures/mini-flake at `84c1ddc` (v0.5.1 + timing)

`extract --all`, 5 cold + 5 warm runs, 2026-07-26. Peak RSS here is `time -v`'s largest single
child, not a tree total.

| leg | runs | min (s) | median (s) | mean (s) | max (s) | stddev (s) | CPU | peak RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cold | 5 | 0.52 | 0.75 | 0.66 | 0.75 | 0.11 | 98% | 44 MiB |
| warm | 5 | 0.09 | 0.09 | 0.14 | 0.34 | 0.10 | 113% | 43 MiB |

| phase | cold (s) | warm (s) |
| --- | ---: | ---: |
| manifest | 0.07 | 0.07 |
| reconcile | 0.00 | 0.00 |
| options | 0.04 | 0.00 |
| packages | 0.39 | 0.00 |
| total | 0.75 | 0.09 |

1 configuration, 5 packages. Load average 7.3 on 24 cores for both legs. One warning on the cold
leg — `meta unavailable for packages/x86_64-linux/mini-broken-meta` — which the fixture provokes on
purpose.

## History: `~/src/github/kriswill/dotfiles` at `c45eb23` (v0.5.1 + timing)

`extract --all`, 2 cold + 3 warm runs, 2026-07-26, before configurations and packages ran
concurrently. Peak RSS is `time -v`'s largest single child, not a tree total. 123 files, 57 inputs,
1 NixOS configuration (`nixos/nebula`, ~15.4k options), 18 packages.

| leg | runs | min (s) | median (s) | mean (s) | max (s) | stddev (s) | CPU | peak RSS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| cold | 2 | 144.40 | 146.16 | 146.16 | 147.93 | 1.76 | 428% | 5.9 GiB |
| warm | 3 | 0.98 | 0.98 | 0.98 | 0.98 | 0.00 | 109% | 247 MiB |

| phase | cold (s) | warm (s) |
| --- | ---: | ---: |
| manifest | 0.94 | 0.96 |
| reconcile | 0.00 | 0.00 |
| options | 94.17 | 0.00 |
| packages | 51.01 | 0.00 |
| total | 146.15 | 0.97 |

Load average 5.6 on 24 cores for both legs; no competing extraction was detected beside any sample.
14 warnings on the cold leg, all per-option eval failures inside `nixos/nebula` (a few options
whose values cannot be evaluated at full detail — the extractor's degradation ladder subtracting,
as designed). The warm leg reports none because it re-extracts nothing.

**This run did not degrade.** The brief these baselines were taken for describes this flake as
hitting an unresolvable transitive-input error, which drops the manifest walk to direct inputs only.
It did not happen here — 57 inputs were resolved and no such warning appeared, on this run or on the
coordinator's hand-run the same day. Comparisons are only valid against another non-degraded run;
`degraded` in the JSON report is the field to check first, because a degraded run does strictly less
work and would look like a speedup.

Peak RSS of ~5.9 GiB is the cold leg's most actionable number after wall clock: it bounds how much
of the options pass can be run concurrently before the machine, not the extractor, becomes the
limit.


## What the shape says

Written against the `84c1ddc` rows above, and still the reason the later work went where it did —
both of the passes named here have since been made concurrent (`bd324da`) and their chunks batched
(`2669eaf`).

The extractor is subprocess-bound, not CPU-bound, and the two flakes say so differently.

- **mini-flake**: 5 packages take 0.39s of the 0.75s cold total, extracted one after another at
  roughly 80ms each, at 98% CPU — one core busy, 23 idle, waiting on `nix`.
- **dotfiles**: 94s of options and 51s of packages against a 0.94s manifest pass. The options pass
  has a worker pool, which is why this run reaches 428% CPU where mini-flake reaches one core; the
  18 packages behind it do not, and 51s of them is 2.8s each, one at a time.
- Both warm legs are the manifest pass alone — 0.09s for the fixture, 0.98s for dotfiles. It is
  regenerated on every run by design, so it is the floor no cache can lower, and on dotfiles it is
  already 100x cheaper than the passes it gates.

## Known gap: the manifest pass has no subphases

The task these baselines were taken for asked for manifest subphases — `nix flake metadata`, `nix
flake show`, the manifest eval, the git walk, the source scans. They are not here. Those calls live
inside `build_manifest` in `flake-explorer-extract`, whose sources are content-hashed into every
user's extraction cache key ([`crates/extract/build.rs`](../crates/extract/build.rs)), so
instrumenting them would throw away every cached blob on every machine for a change that cannot
alter a blob's bytes. The timer therefore measures the manifest pass as one number from the driver
side. Whoever next changes `crates/extract` for its own reasons — the cache invalidation is already
paid at that point — is the right person to split it.
