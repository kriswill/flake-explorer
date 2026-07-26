// The measuring parts of the bench harness, pinned without spawning nix: a
// benchmark that mis-parses its own instrumentation reports confident wrong
// numbers, which is worse than reporting none. Everything here is pure — the
// spawning half is exercised by running the script.

import { describe, expect, test } from "bun:test"
import {
  countExtractions,
  DEGRADED_WARNING,
  medianOf,
  parseArgs,
  parseGnuTime,
  parseTimings,
  phaseMedians,
  renderMarkdown,
  type Sample,
  statsOf,
  summarizeWarnings,
} from "./bench-extract"

const GNU_TIME = `	Command being timed: "flake-explorer extract"
	User time (seconds): 526.02
	System time (seconds): 81.03
	Percent of CPU this job got: 404%
	Elapsed (wall clock) time (h:mm:ss or m:ss): 2:29.91
	Maximum resident set size (kbytes): 3145728
	Exit status: 0
`

const TIMED_STDERR = `timing: manifest 97ms
timing: reconcile 0ms
timing:   options nixos/mini 58ms
timing: options 58ms
timing:   package packages/x86_64-linux/mini 94ms
timing:   package formatter/x86_64-linux 89ms
timing: packages 682ms
timing: total 856ms
`

describe("parseArgs", () => {
  test("takes the flakeref positionally and defaults the rest", () => {
    const o = parseArgs(["./fixtures/mini-flake"])
    expect(o.flakeRef).toBe("./fixtures/mini-flake")
    expect(o.label).toBe("mini-flake")
    expect(o.coldRuns).toBe(3)
    expect(o.warmRuns).toBe(3)
    expect(o.extractArgs).toEqual(["--all"])
    expect(o.build).toBe(true)
  })

  test("reads the flags", () => {
    const o = parseArgs([
      "~/src/dotfiles",
      "--label",
      "dotfiles",
      "--runs",
      "1",
      "--warm-runs",
      "2",
      "--json",
      "out.json",
      "--no-build",
      "--extract-args",
      "--all --all-systems",
    ])
    expect(o.label).toBe("dotfiles")
    expect(o.coldRuns).toBe(1)
    expect(o.warmRuns).toBe(2)
    expect(o.jsonPath).toBe("out.json")
    expect(o.build).toBe(false)
    expect(o.extractArgs).toEqual(["--all", "--all-systems"])
  })

  test("refuses what it cannot measure", () => {
    expect(() => parseArgs([])).toThrow("flakeref")
    expect(() => parseArgs([".", "--runs", "0"])).toThrow("--runs")
    expect(() => parseArgs([".", "--runs"])).toThrow("expects a value")
    expect(() => parseArgs([".", "--bogus"])).toThrow("unknown flag")
  })
})

describe("statsOf", () => {
  test("min, median, mean, max and spread", () => {
    const s = statsOf([300, 100, 200])
    expect(s.runs).toBe(3)
    expect(s.minMs).toBe(100)
    expect(s.medianMs).toBe(200)
    expect(s.meanMs).toBe(200)
    expect(s.maxMs).toBe(300)
    expect(s.stddevMs).toBeCloseTo(81.65, 1)
  })

  test("an even count averages the middle pair", () => {
    expect(medianOf([1, 2, 3, 4])).toBe(2.5)
    expect(medianOf([])).toBe(0)
  })
})

describe("parseGnuTime", () => {
  test("pulls CPU, cpu-seconds and peak RSS out of -v output", () => {
    const t = parseGnuTime(GNU_TIME)
    expect(t.userSeconds).toBe(526.02)
    expect(t.systemSeconds).toBe(81.03)
    expect(t.cpuPercent).toBe(404)
    expect(t.maxRssKb).toBe(3145728)
  })

  test("absent when the wrapper did not run", () => {
    const t = parseGnuTime("extracting manifest ...\n")
    expect(t.cpuPercent).toBeNull()
    expect(t.maxRssKb).toBeNull()
  })
})

describe("parseTimings", () => {
  test("separates phase totals from the items inside them", () => {
    const { phases, items } = parseTimings(TIMED_STDERR)
    expect(phases).toEqual({
      manifest: 97,
      reconcile: 0,
      options: 58,
      packages: 682,
      total: 856,
    })
    expect(items).toEqual([
      { phase: "options", id: "nixos/mini", ms: 58 },
      { phase: "package", id: "packages/x86_64-linux/mini", ms: 94 },
      { phase: "package", id: "formatter/x86_64-linux", ms: 89 },
    ])
  })

  test("an uninstrumented run has no phases", () => {
    expect(parseTimings("extracting manifest ...\n").phases).toEqual({})
  })

  test("medians a phase across samples, ignoring samples that lack it", () => {
    const s = (phases: Record<string, number>) => ({ phases }) as unknown as Sample
    const med = phaseMedians([s({ manifest: 100 }), s({ manifest: 200, options: 50 })])
    expect(med).toEqual({ manifest: 150, options: 50 })
  })
})

describe("summarizeWarnings", () => {
  test("counts them and notices the transitive-input degradation", () => {
    const w = summarizeWarnings(`  warn: a thing went wrong\n  warn: ${DEGRADED_WARNING} — boom\n`)
    expect(w.count).toBe(2)
    expect(w.degraded).toBe(true)
    expect(w.samples[0]).toBe("a thing went wrong")
  })

  test("a clean run is not degraded", () => {
    const w = summarizeWarnings("extracting manifest ...\n")
    expect(w).toEqual({ count: 0, degraded: false, samples: [] })
  })
})

describe("countExtractions", () => {
  // Real `ps -eo pid=,args=` lines from this machine: two coding agents whose
  // own command line quotes "flake-explorer extract", the zsh wrapper that
  // launched a run, and the one process that is actually extracting.
  const PS = [
    "  809327 /home/k/src/flake-explorer/target/release/flake-explorer extract /home/k/df --out d",
    "  830290 claude --model opus ... measures `flake-explorer extract <flakeref> --out <tmpdir>`",
    "  809324 /run/current-system/sw/bin/zsh -c eval 'flake-explorer extract ~/df --out bench'",
    "  999999 flake-explorer serve /home/k/df",
  ].join("\n")

  test("counts extractions, not processes that merely name one", () => {
    expect(countExtractions(PS)).toBe(1)
  })

  test("ignores the pids it is told to", () => {
    expect(countExtractions(PS, [809327])).toBe(0)
  })

  test("a bare PATH invocation counts", () => {
    expect(countExtractions("  4242 flake-explorer extract .")).toBe(1)
  })
})

describe("renderMarkdown", () => {
  const report = {
    tool: "bench-extract",
    schemaVersion: 1,
    label: "mini-flake",
    flakeRef: "./fixtures/mini-flake",
    extractArgs: ["--all"],
    commit: "37a16e9",
    dirty: false,
    startedAt: "2026-07-25T19:00:00.000Z",
    machine: { nproc: 24, arch: "x64", platform: "linux", nix: "nix 2.34.8", hyperfine: null },
    cold: {
      stats: statsOf([1000, 1100, 1200]),
      phases: { manifest: 100, total: 1100 },
      cpuPercent: 110,
      maxRssKb: 1024,
      warnings: { count: 0, degraded: false, samples: [] },
      contended: false,
      loadAvg1: 3.5,
    },
    warm: {
      stats: statsOf([300]),
      phases: { manifest: 90, total: 300 },
      cpuPercent: 90,
      maxRssKb: 512,
      warnings: { count: 0, degraded: false, samples: [] },
      contended: false,
      loadAvg1: 3.5,
    },
    notes: ["cold clears the data dir only"],
  }

  test("a table a human reads and a commit a reader can attribute it to", () => {
    const md = renderMarkdown(report)
    expect(md).toContain("mini-flake")
    expect(md).toContain("37a16e9")
    expect(md).toContain("| cold |")
    expect(md).toContain("| warm |")
    expect(md).toContain("manifest")
    expect(md).toContain("cold clears the data dir only")
    // Seconds, not raw milliseconds — the numbers span 0.05s to 150s.
    expect(md).toContain("1.10")
    // Load average: the neighbours that skew a sample are not always
    // extractions, so the report says how busy the machine was regardless.
    expect(md).toContain("3.5")
  })
})
