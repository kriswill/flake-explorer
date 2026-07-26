// Reproducible wall-clock benchmark for `flake-explorer extract`, cold and
// warm, with the per-phase breakdown FLAKE_EXPLORER_TIMINGS emits (src/timing.rs).
//
//   bun scripts/bench-extract.ts ./fixtures/mini-flake
//   bun scripts/bench-extract.ts ~/src/github/kriswill/dotfiles --runs 1 --json out.json
//
// WHAT COLD MEANS HERE. A fresh --out directory, so no sidecar is reusable and
// every configuration and package is extracted again. It is NOT a cold machine:
// nix's eval cache and the store stay warm, and they dominate a first-ever run.
// Measured on this repo's fixture, the same extraction is ~4.4s against a cold
// eval cache and ~0.9s against a warm one — a 5x gap that has nothing to do with
// the extractor. Cold-here is the number that moves when the extractor changes,
// which is what a regression harness wants; it is not the number a user sees on
// their first run, and BASELINES.md says so beside every figure.
//
// WHY NOT HYPERFINE. It is not on PATH on this machine, and `nix run
// nixpkgs#hyperfine` would put a download inside the thing being measured. It
// also cannot do the two jobs that matter most here: sequencing cold and warm
// runs against the same data dir (its --prepare would have to wipe the dir the
// warm run depends on), and reading the phase lines back out of stderr. The
// loop below spawns under GNU time -v when it is available, so each sample
// carries CPU percentage and peak RSS as well as wall clock — the extractor is
// subprocess-bound, and "11% CPU" is the finding that starts an investigation.
//
// CONTENTION. Several extractions on one machine make every number a lie, so
// the harness waits for a competing `flake-explorer extract` before each run
// and flags any sample another one appeared beside.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { cpus, loadavg } from "node:os"
import { basename, dirname, join } from "node:path"

const ROOT = dirname(import.meta.dir)

/** The manifest-pass degradation this repo's reference flake is known to hit:
 *  an unresolvable transitive input drops the walk to direct inputs only. A
 *  degraded run does less work, so comparing one against a clean one is
 *  meaningless — every report records which it was. */
export const DEGRADED_WARNING = "transitive inputs could not be resolved"

export interface Options {
  flakeRef: string
  label: string
  coldRuns: number
  warmRuns: number
  extractArgs: string[]
  jsonPath: string | null
  format: "md" | "json"
  binary: string | null
  outDir: string | null
  build: boolean
  wait: boolean
  timeoutMs: number
}

export interface Stats {
  runs: number
  minMs: number
  medianMs: number
  meanMs: number
  maxMs: number
  stddevMs: number
}

export interface TimingItem {
  phase: string
  id: string
  ms: number
}

export interface WarningSummary {
  count: number
  degraded: boolean
  samples: string[]
}

export interface Sample {
  wallMs: number
  exitCode: number
  cpuPercent: number | null
  userSeconds: number | null
  systemSeconds: number | null
  maxRssKb: number | null
  phases: Record<string, number>
  items: TimingItem[]
  warnings: WarningSummary
  contended: boolean
  loadAvg1: number
}

export interface Leg {
  stats: Stats
  phases: Record<string, number>
  cpuPercent: number | null
  maxRssKb: number | null
  warnings: WarningSummary
  contended: boolean
  /** 1-minute load at each run's end, medianed. The neighbours that skew a
   *  sample are not always extractions — a teammate's test suite evaluating
   *  nix will not show up in countExtractions but will show up here. */
  loadAvg1: number
}

export interface Report {
  tool: string
  schemaVersion: number
  label: string
  flakeRef: string
  extractArgs: string[]
  commit: string
  dirty: boolean
  startedAt: string
  machine: {
    nproc: number
    arch: string
    platform: string
    nix: string
    hyperfine: string | null
  }
  cold: Leg
  warm: Leg
  notes: string[]
}

// ------------------------------------------------------------------ parsing

export function parseArgs(argv: string[]): Options {
  const o: Options = {
    flakeRef: "",
    label: "",
    coldRuns: 3,
    warmRuns: 3,
    extractArgs: ["--all"],
    jsonPath: null,
    format: "md",
    binary: null,
    outDir: null,
    build: true,
    wait: true,
    timeoutMs: 3_600_000,
  }
  // A missing value must be an error, not a silent default (main.rs takes the
  // same line). --extract-args is the one flag whose value is legitimately
  // flag-shaped, so only it may start with a dash.
  const value = (flag: string, raw: string | undefined, dashes = false): string => {
    if (raw === undefined || (!dashes && raw.startsWith("--"))) {
      throw new Error(`${flag} expects a value`)
    }
    return raw
  }
  const count = (flag: string, raw: string | undefined): number => {
    const n = Number(value(flag, raw))
    if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} expects a positive integer`)
    return n
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case "--label":
        o.label = value(a, argv[++i])
        break
      case "--runs":
        o.coldRuns = count(a, argv[++i])
        break
      case "--warm-runs":
        o.warmRuns = count(a, argv[++i])
        break
      case "--extract-args":
        o.extractArgs = value(a, argv[++i], true).split(/\s+/).filter(Boolean)
        break
      case "--json":
        o.jsonPath = value(a, argv[++i])
        break
      case "--format": {
        const f = value(a, argv[++i])
        if (f !== "md" && f !== "json") throw new Error("--format expects md or json")
        o.format = f
        break
      }
      case "--binary":
        o.binary = value(a, argv[++i])
        break
      case "--out":
        o.outDir = value(a, argv[++i])
        break
      case "--timeout":
        o.timeoutMs = count(a, argv[++i]) * 1000
        break
      case "--no-build":
        o.build = false
        break
      case "--no-wait":
        o.wait = false
        break
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`)
        if (o.flakeRef) throw new Error(`only one flakeref, got also: ${a}`)
        o.flakeRef = a
    }
  }
  if (!o.flakeRef) throw new Error("usage: bench-extract.ts <flakeref> [--runs N] [--json FILE]")
  if (!o.label) o.label = basename(o.flakeRef.replace(/\/+$/, "")) || o.flakeRef
  return o
}

export function medianOf(values: number[]): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid]
}

export function statsOf(values: number[]): Stats {
  const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0
  const variance = values.length
    ? values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length
    : 0
  return {
    runs: values.length,
    minMs: values.length ? Math.min(...values) : 0,
    medianMs: medianOf(values),
    meanMs: mean,
    maxMs: values.length ? Math.max(...values) : 0,
    stddevMs: Math.sqrt(variance),
  }
}

/** GNU `time -v` output. Every field is optional: without the wrapper on PATH
 *  the runs still happen, they just carry wall clock alone. */
export function parseGnuTime(text: string): {
  userSeconds: number | null
  systemSeconds: number | null
  cpuPercent: number | null
  maxRssKb: number | null
} {
  const num = (re: RegExp): number | null => {
    const m = text.match(re)
    return m ? Number(m[1]) : null
  }
  return {
    userSeconds: num(/User time \(seconds\):\s*([\d.]+)/),
    systemSeconds: num(/System time \(seconds\):\s*([\d.]+)/),
    cpuPercent: num(/Percent of CPU this job got:\s*(\d+)%/),
    maxRssKb: num(/Maximum resident set size \(kbytes\):\s*(\d+)/),
  }
}

/** The lines src/timing.rs writes: `timing: <phase> <ms>ms` for a pass and
 *  `timing:   <phase> <id> <ms>ms` for one item inside it. */
export function parseTimings(text: string): {
  phases: Record<string, number>
  items: TimingItem[]
} {
  const phases: Record<string, number> = {}
  const items: TimingItem[] = []
  for (const line of text.split("\n")) {
    const item = line.match(/^timing:\s{3}(\S+)\s+(\S+)\s+(\d+)ms$/)
    if (item) {
      items.push({ phase: item[1], id: item[2], ms: Number(item[3]) })
      continue
    }
    const phase = line.match(/^timing:\s(\S+)\s+(\d+)ms$/)
    if (phase) phases[phase[1]] = Number(phase[2])
  }
  return { phases, items }
}

/** Per-phase median across a leg's samples. A phase missing from a sample (an
 *  empty options pass emits none) is skipped rather than counted as zero. */
export function phaseMedians(samples: Sample[]): Record<string, number> {
  const collected: Record<string, number[]> = {}
  for (const s of samples) {
    for (const [label, ms] of Object.entries(s.phases)) {
      if (!collected[label]) collected[label] = []
      collected[label].push(ms)
    }
  }
  const out: Record<string, number> = {}
  for (const [label, values] of Object.entries(collected)) out[label] = medianOf(values)
  return out
}

export function summarizeWarnings(text: string): WarningSummary {
  const warnings = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("warn: "))
    .map((l) => l.slice("warn: ".length))
  return {
    count: warnings.length,
    degraded: warnings.some((w) => w.includes(DEGRADED_WARNING)),
    samples: [...new Set(warnings)].slice(0, 5),
  }
}

// ----------------------------------------------------------------- report

const secs = (ms: number): string => (ms / 1000).toFixed(2)

function phaseTable(cold: Record<string, number>, warm: Record<string, number>): string[] {
  const labels = [...new Set([...Object.keys(cold), ...Object.keys(warm)])]
  if (labels.length === 0) return []
  const order = ["manifest", "reconcile", "options", "packages", "total"]
  labels.sort((a, b) => order.indexOf(a) - order.indexOf(b))
  return [
    "",
    "| phase | cold (s) | warm (s) |",
    "| --- | ---: | ---: |",
    ...labels.map(
      (l) => `| ${l} | ${l in cold ? secs(cold[l]) : "—"} | ${l in warm ? secs(warm[l]) : "—"} |`,
    ),
  ]
}

export function renderMarkdown(r: Report): string {
  const leg = (name: string, l: Leg) =>
    `| ${name} | ${l.stats.runs} | ${secs(l.stats.minMs)} | ${secs(l.stats.medianMs)} | ` +
    `${secs(l.stats.meanMs)} | ${secs(l.stats.maxMs)} | ${secs(l.stats.stddevMs)} | ` +
    `${l.cpuPercent === null ? "—" : `${l.cpuPercent}%`} | ` +
    `${l.maxRssKb === null ? "—" : `${(l.maxRssKb / 1024).toFixed(0)} MiB`} |`

  const lines = [
    `### ${r.label} — \`${r.flakeRef}\``,
    "",
    `\`extract ${r.extractArgs.join(" ")}\` at \`${r.commit}\`${r.dirty ? " (dirty tree)" : ""}, ` +
      `${r.startedAt}`,
    "",
    "| leg | runs | min (s) | median (s) | mean (s) | max (s) | stddev (s) | CPU | peak RSS |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    leg("cold", r.cold),
    leg("warm", r.warm),
    ...phaseTable(r.cold.phases, r.warm.phases),
    "",
    `Machine: ${r.machine.nproc} cores, ${r.machine.platform}/${r.machine.arch}, ` +
      `\`${r.machine.nix}\`.`,
    `Load average (1 min, at run end): ${r.cold.loadAvg1} cold, ${r.warm.loadAvg1} warm ` +
      `on ${r.machine.nproc} cores.`,
    `Warnings: ${r.cold.warnings.count} cold, ${r.warm.warnings.count} warm` +
      `${r.cold.warnings.degraded ? " — DEGRADED (transitive inputs unresolved)" : ""}.`,
  ]
  if (r.cold.contended || r.warm.contended) {
    lines.push("**Contended: another extraction was running beside a sample — retake this.**")
  }
  for (const n of r.notes) lines.push(`- ${n}`)
  return `${lines.join("\n")}\n`
}

// ---------------------------------------------------------------- spawning

/** Provenance for the report — git, nix. Absent or failing tools leave the
 *  field empty rather than killing the run: spawnSync THROWS on a missing
 *  executable, which is how a `nix`-less sandbox turned a report field into a
 *  crash. Better an "unknown" commit than no numbers. */
function capture(cmd: string[], cwd = ROOT): string {
  try {
    const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
    return p.success ? new TextDecoder().decode(p.stdout).trim() : ""
  } catch {
    return ""
  }
}

/** GNU time, not the shell builtin, and only if it understands -v. */
function gnuTime(): string | null {
  const path = Bun.which("time")
  if (!path) return null
  const p = Bun.spawnSync([path, "-v", "true"], { stdout: "pipe", stderr: "pipe" })
  const out = new TextDecoder().decode(p.stderr)
  return out.includes("Maximum resident set size") ? path : null
}

/** Extractions running in `ps -eo pid=,args=` output, ignoring `ignorePids`.
 *
 *  A substring match is not good enough and the failure is not hypothetical:
 *  `pgrep -f 'flake-explorer extract'` on this machine matches the coding
 *  agents whose own command line quotes that phrase and the shell wrapper that
 *  launched a run, so the harness waited forever for extractions that did not
 *  exist. What counts is an unquoted argv token whose basename is the binary
 *  followed by `extract` — a bare invocation, or one this harness started
 *  behind `time -v`, and nothing that merely writes the words down. */
export function countExtractions(ps: string, ignorePids: number[] = []): number {
  let n = 0
  for (const line of ps.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/)
    if (!m) continue
    if (ignorePids.includes(Number(m[1]))) continue
    const argv = m[2].split(/\s+/)
    if (argv.some((a, i) => basename(a) === "flake-explorer" && argv[i + 1] === "extract")) n++
  }
  return n
}

/** Teammates and the coordinator share this machine, and a 24-core nix eval
 *  next door invalidates a sample. */
function competingExtractions(): number {
  try {
    const p = Bun.spawnSync(["ps", "-eo", "pid=,args="], { stdout: "pipe", stderr: "pipe" })
    return countExtractions(new TextDecoder().decode(p.stdout), [process.pid])
  } catch {
    // No ps (a build sandbox, a minimal container): measure rather than refuse,
    // and let the load average in the report speak for the machine instead.
    return 0
  }
}

async function waitForQuiet(enabled: boolean): Promise<void> {
  if (!enabled) return
  let waited = 0
  while (competingExtractions() > 0) {
    if (waited === 0) console.error("another extraction is running — waiting for it to finish")
    await Bun.sleep(5000)
    waited += 5
    if (waited > 1800) {
      console.error("still busy after 30 min — measuring anyway, samples will be flagged")
      return
    }
  }
}

function runOnce(o: Options, binary: string, outDir: string, timePath: string | null): Sample {
  const argv = [binary, "extract", o.flakeRef, "--out", outDir, ...o.extractArgs]
  const cmd = timePath ? [timePath, "-v", ...argv] : argv
  const started = performance.now()
  const p = Bun.spawnSync(cmd, {
    cwd: ROOT,
    env: { ...process.env, FLAKE_EXPLORER_TIMINGS: "1" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: o.timeoutMs,
  })
  const wallMs = performance.now() - started
  const stderr = new TextDecoder().decode(p.stderr)
  const { phases, items } = parseTimings(stderr)
  return {
    wallMs,
    exitCode: p.exitCode ?? -1,
    ...parseGnuTime(stderr),
    phases,
    items,
    warnings: summarizeWarnings(stderr),
    contended: competingExtractions() > 0,
    loadAvg1: loadavg()[0],
  }
}

function legOf(samples: Sample[]): Leg {
  const defined = (pick: (s: Sample) => number | null): number | null => {
    const values = samples.map(pick).filter((v): v is number => v !== null)
    return values.length ? Math.round(medianOf(values)) : null
  }
  return {
    stats: statsOf(samples.map((s) => s.wallMs)),
    phases: phaseMedians(samples),
    cpuPercent: defined((s) => s.cpuPercent),
    maxRssKb: defined((s) => s.maxRssKb),
    warnings: samples[samples.length - 1]?.warnings ?? { count: 0, degraded: false, samples: [] },
    contended: samples.some((s) => s.contended),
    loadAvg1: Number(medianOf(samples.map((s) => s.loadAvg1)).toFixed(1)),
  }
}

export async function main(argv: string[]): Promise<number> {
  let o: Options
  try {
    o = parseArgs(argv)
  } catch (e) {
    console.error(`bench-extract: ${(e as Error).message}`)
    return 1
  }

  if (o.build) {
    console.error("building the release binary ...")
    const b = Bun.spawnSync(["cargo", "build", "--release"], { cwd: ROOT, stdio: [null, 2, 2] })
    if (!b.success) {
      console.error("bench-extract: cargo build --release failed")
      return 1
    }
  }
  const binary = o.binary ?? join(ROOT, "target/release/flake-explorer")
  if (!existsSync(binary)) {
    console.error(`bench-extract: no binary at ${binary} (drop --no-build?)`)
    return 1
  }

  const outDir = o.outDir ?? join(process.env.TMPDIR ?? "/tmp", `bench-extract-${o.label}`)
  mkdirSync(dirname(outDir), { recursive: true })
  const timePath = gnuTime()
  const startedAt = new Date().toISOString()

  const cold: Sample[] = []
  for (let i = 0; i < o.coldRuns; i++) {
    await waitForQuiet(o.wait)
    rmSync(outDir, { recursive: true, force: true })
    console.error(`cold run ${i + 1}/${o.coldRuns} ...`)
    const s = runOnce(o, binary, outDir, timePath)
    if (s.exitCode !== 0) {
      console.error(`bench-extract: extraction exited ${s.exitCode}`)
      return 1
    }
    cold.push(s)
  }
  // Warm runs reuse the directory the last cold run filled: every sidecar is
  // valid, so this leg measures the manifest pass plus cache reconciliation.
  const warm: Sample[] = []
  for (let i = 0; i < o.warmRuns; i++) {
    await waitForQuiet(o.wait)
    console.error(`warm run ${i + 1}/${o.warmRuns} ...`)
    warm.push(runOnce(o, binary, outDir, timePath))
  }

  const report: Report = {
    tool: "bench-extract",
    schemaVersion: 1,
    label: o.label,
    flakeRef: o.flakeRef,
    extractArgs: o.extractArgs,
    commit: capture(["git", "rev-parse", "--short", "HEAD"]) || "unknown",
    dirty: capture(["git", "status", "--porcelain"]).length > 0,
    startedAt,
    machine: {
      nproc: cpus().length,
      arch: process.arch,
      platform: process.platform,
      nix: capture(["nix", "--version"]) || "unknown",
      hyperfine: Bun.which("hyperfine"),
    },
    cold: legOf(cold),
    warm: legOf(warm),
    notes: [
      "cold = fresh --out dir; nix's eval cache and store stay warm, so a " +
        "first-ever run on a machine is much slower than this.",
      timePath ? `CPU and RSS from ${timePath} -v.` : "GNU time -v absent: wall clock only.",
      "Phase rows come from FLAKE_EXPLORER_TIMINGS=1 (medians across the leg's runs).",
    ],
  }

  if (o.jsonPath) writeFileSync(o.jsonPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(o.format === "json" ? JSON.stringify(report, null, 2) : renderMarkdown(report))
  rmSync(outDir, { recursive: true, force: true })
  return 0
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
