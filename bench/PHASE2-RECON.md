# Phase-2 recon: where the options pass spends its time

Measurement only — nothing in the extractor changed. The question is what the next
optimization should attack, given [`bench/BASELINES.md`](BASELINES.md): a cold
dotfiles extraction is 146s and 94s of it is the options pass for one NixOS
configuration.

Everything here comes from [`examples/options-probe.rs`](../examples/options-probe.rs),
which calls `extract_options` directly so the worker count can be set per run and
every chunk completion can be timestamped, and from raw `nix eval` timings that
reproduce the extractor's own command shape.

Target: `~/src/github/kriswill/dotfiles`, `nixos/nebula` — 15,436 options, 479
customized, 14 warnings. 24 cores, `nix (Determinate Nix 3.21.5) 2.34.8`,
2026-07-25, at `24e3463` (main plus the probe example). Every wall-clock and
memory figure below was taken while holding the team's exclusive `heavy.lock`;
an earlier unlocked sweep is discarded.

## The three findings

**1. The pass runs 348 chunk evaluations to cover 59 namespaces.** Failure-driven
binary splitting is the multiplier, not the option count.

**2. No single chunk is the long pole.** `services` alone is 223 of the 348 evals
and 57% of the serial time — spread across 223 mostly-cheap calls, not one slow one.

**3. Every one of those calls re-pays ~580ms of flake and module-system setup
before it does any chunk-specific work.** That is 202s of the 379s serial total —
53% of the pass is the same NixOS configuration being evaluated from scratch, 348
times over.

## 1. Worker-count sweep

| jobs | wall | speedup | efficiency | CPU | CPU-seconds | peak RSS |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 378.9s | 1.00x | 100% | 107% | 405 | 5.22 GiB |
| 2 | 201.2s | 1.88x | 94% | 219% | 441 | 5.39 GiB |
| 4 | 109.0s | 3.48x | 87% | 433% | 472 | 5.41 GiB |
| 8 | 75.4s | 5.03x | 63% | 683% | 515 | 6.29 GiB |
| 12 | 64.3s | 5.89x | 49% | 903% | 581 | 5.61 GiB |

Every leg produced the same 348 chunks, 15,436 options and 14 warnings, so these
are the same work done at different widths.

Scaling is near-linear to 4 and falls off hard after 8. The current default on this
machine is 8 (`cores - 2`, clamped 2..8), which is close to the knee: going to 12
buys 15% wall for 13% more CPU-seconds. **The total CPU cost grows 43% from jobs=1
to jobs=12** (405 → 581 CPU-seconds) — the extra workers are not doing extra work,
they are contending, so past the knee the machine gets hotter without finishing
much sooner.

On peak RSS, read the number carefully: GNU `time -v` reports the largest single
child, not the sum, so **~5.2 GiB is what ONE `nix eval` of this configuration
peaks at** — even at jobs=1. The concurrent total is not measured here and is the
figure that would decide a safe default on a smaller machine: 8 workers that each
transiently need several GiB is a plausible OOM on a 16 GiB laptop, and it is the
reason not to raise the default cap on machine-size grounds alone. This box has
62 GiB and never dropped below 43 GiB available, so nothing here was memory-bound.

## 2. Where the chunks go

Exact per-chunk durations, from the jobs=1 leg (at width 1 the gaps between
consecutive completions ARE the chunk durations):

| | ms |
| --- | ---: |
| chunks | 348 |
| min | 572 |
| p50 | 704 |
| p90 | 1,658 |
| p99 | 8,351 |
| max | 9,402 (`boot`) |

By top-level namespace:

| namespace | evals | serial time | share |
| --- | ---: | ---: | ---: |
| `services` | 223 | 217.1s | 57% |
| `programs` | 50 | 53.3s | 14% |
| `snowglobe-lib` | 19 | 17.1s | 5% |
| `boot` | 1 | 9.4s | 2% |
| `system` | 1 | 8.6s | 2% |
| `environment` | 1 | 8.5s | 2% |
| `documentation` | 1 | 8.4s | 2% |
| `systemd` | 1 | 7.9s | 2% |
| everything else (52 namespaces) | 51 | ~48s | 13% |

**Evenly spread, not a long pole.** The individually slowest chunk in the whole run
is `boot` at 9.4s — 2.5% of the serial total. What dominates is `services` being
evaluated 223 times at an average of 0.97s. The completion timeline at jobs=8 says
the same thing from the other side: quartiles land at 32s / 52s / 68s of a 75s run
and the last eight completions are 250-600ms apart, so the workers stay fed to the
end. There is no straggler to chase.

The 223 comes from `run_chunk`'s recovery path. A chunk that fails to evaluate
re-queues its children in two halves; each half is a fresh full evaluation. A
namespace with a handful of options that throw therefore binary-searches its way
through dozens of extra evals — and `services` on this configuration has several
(`services.netbox.settings`, `services.pretix.settings`, `services.pretalx.settings`,
`services.dawarich.redis.host`, `services.immich.redis.host`, … 14 in all). The
queue grew from 59 to 348 as those searches ran: 59 namespaces in, 289 extra
evaluations out.

## 3. What one `nix eval` costs before it does anything

Same command shape the extractor uses — `nix eval --impure --json --expr 'import
extract.nix (builtins.fromJSON …)'` — varying only how much the expression asks for.
Three repetitions each:

| probe | reps (ms) | what it measures |
| --- | --- | --- |
| `--expr '1'` | 134 / 16 / 18 | nix process start, no flake |
| `optionNames` for `nixos/nebula` | 596 / 594 / 773 | flake load + module-system eval, then `attrNames` |
| chunk `isSpecialisation` | 590 / 578 / 822 | same setup, then a one-option namespace |
| chunk `assertions` | 591 / 581 / 818 | " |
| chunk `time` | 599 / 591 / 799 | " |
| chunk `ids` | 592 / 589 / 811 | " |
| chunk `boot` | 9,337 / 9,791 / 10,095 | setup + a genuinely large namespace |
| chunk `services` | 2,786 / 2,645 / 2,664 (all **fail**) | setup, then the failure that starts the splitting |

**The floor is ~580ms and it is nearly all setup.** Process start is 17ms; the other
~563ms is loading the flake and evaluating the NixOS module system, and it is paid
identically whether the chunk then returns one option or ten thousand. The four
trivial-namespace probes and the `optionNames` probe agree to within 20ms, which is
what "fixed cost" looks like.

**Repeats do not get cheaper.** `nix`'s eval cache keys on flake attribute paths;
`--expr` evaluations are not cached, so the third call costs what the first did.
This is measured, not assumed — see the reps above, and note the third rep of each
probe is consistently ~200ms slower rather than faster.

Multiplying out: 348 evals × 0.58s = **202s of the 379s serial pass is re-paid
setup (53%)**. At the current default of 8 workers that is ~25s of the 75s wall
clock. The floor also explains the p50: a 704ms median chunk is ~580ms of setup and
~120ms of work.

## What this implies for the next optimization

In rough order of expected value:

1. **Stop re-paying the setup.** 202s of the serial pass is one flake load and one
   module-system evaluation repeated 348 times. Anything that amortizes it —
   evaluating more per call, or holding one nix evaluation open across chunks —
   attacks the largest single line item, and unlike widening the pool it does not
   cost more CPU-seconds.
2. **Make failure cheaper than binary search.** 289 of the 348 evals exist to
   isolate 14 bad options. A cheaper isolation strategy (or evaluating children
   individually once a namespace is known to fail, rather than halving repeatedly)
   removes evals outright rather than making them faster.
3. **Leave the worker count alone.** 8 is at the knee: 12 gains 15% wall for 13%
   more CPU-seconds, and per-eval peak RSS makes a higher default risky on small
   machines. Width is not where the remaining win is.

Bear in mind that 1 and 2 interact: halving the number of evals halves the setup
bill too, and a cheaper setup makes the splitting less painful. Either alone is
worth more than any amount of extra parallelism.

## Reproducing

```sh
cargo build --release --example options-probe
# one leg of the sweep (hold the team's heavy.lock around it)
/run/current-system/sw/bin/time -v ./target/release/examples/options-probe \
  ~/src/github/kriswill/dotfiles nixos/nebula --jobs 8 --jsonl chunks-8.jsonl
# per-chunk durations from a serial leg
jq -s '[range(0;length) as $i | {ns: .[$i].current,
        ms: (.[$i].ms - (if $i==0 then 0 else .[$i-1].ms end))}] | sort_by(-.ms)' chunks-1.jsonl
```

Wall-clock and memory figures need the exclusive lock: two agents measuring this
flake at once contaminated an earlier sweep in both directions. Counts (348 evals,
the per-namespace split counts) are contention-immune.
