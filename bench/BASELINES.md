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

## Machine

| | |
|---|---|
| Cores | 24 (`nproc`) |
| Platform | linux/x64 |
| Nix | `nix (Determinate Nix 3.21.5) 2.34.8` |
| hyperfine | not installed (the harness times in-process; see the script header) |
| Commit | `84c1ddc` — `perf/bench-harness`, functionally `00f6a4b` plus opt-in timing |
| Date | 2026-07-26 |

## fixtures/mini-flake

`extract --all`, 5 cold + 5 warm runs, 2026-07-26.

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

## ~/src/github/kriswill/dotfiles

`extract --all`, 2 cold + 3 warm runs, 2026-07-26. 123 files, 57 inputs, 1 NixOS configuration
(`nixos/nebula`, ~15.4k options), 18 packages.

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
