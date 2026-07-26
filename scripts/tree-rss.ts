// Tree-scoped memory sampler. GNU `time -v` reports ru_maxrss from
// RUSAGE_CHILDREN, which is the largest SINGLE child, not the sum — for the
// extractor, whose memory lives in N concurrent `nix` processes, that number
// answers the wrong question. This samples the whole process tree.
//
//   bun tree-rss.ts --interval 200 --json out.json -- <command> [args...]
//
// Two totals per sample, because neither alone is honest:
//   rssKb — sum of RSS across the tree. Upper bound: shared pages (libc, the
//           nix binary itself) are counted once per process.
//   pssKb — sum of PSS from /proc/<pid>/smaps_rollup, which divides each shared
//           page by the number of processes mapping it. This is the number to
//           quote for "how much memory did this need", and it is what decides
//           whether a default worker count fits on a 16 GiB machine.
// Peak is over samples, so a spike shorter than the interval can be missed;
// 200ms against evals that run for seconds is a reasonable trade. Sub-second
// commands need a much smaller --interval or the peak is simply not seen.
//
// The two totals are not read atomically — RSS comes from /proc/<pid>/stat and
// PSS from /proc/<pid>/smaps_rollup, microseconds apart — so on a process that
// is growing between the reads, PSS can come out slightly ABOVE RSS even though
// that is impossible at any single instant. Measured: 124431 kB against 123716
// kB on a growing `bun test`. At the scale this exists to measure (multi-GB
// extractions) the skew is noise; do not read a 0.5% gap as meaningful.

import { readdirSync, readFileSync, writeFileSync } from "node:fs"

interface Sample {
  ms: number
  procs: number
  rssKb: number
  pssKb: number
}

interface ProcRow {
  pid: number
  ppid: number
  rssKb: number
}

const PAGE_KB = 4

/** Every process on the machine, with its parent — one pass over /proc. */
export function readProcs(): ProcRow[] {
  const rows: ProcRow[] = []
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8")
      // comm can contain spaces and parens; everything after the last ')' is
      // positional, starting at field 3 (state).
      const rest = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")
      rows.push({
        pid: Number(entry),
        ppid: Number(rest[1]),
        rssKb: Number(rest[21]) * PAGE_KB,
      })
    } catch {
      // The process exited between readdir and read — normal, skip it.
    }
  }
  return rows
}

/** PIDs of `root` and every descendant. */
export function treeOf(rows: ProcRow[], root: number): number[] {
  const children = new Map<number, number[]>()
  for (const r of rows) {
    const list = children.get(r.ppid)
    if (list) list.push(r.pid)
    else children.set(r.ppid, [r.pid])
  }
  const out: number[] = []
  const stack = [root]
  while (stack.length) {
    const pid = stack.pop() as number
    out.push(pid)
    for (const child of children.get(pid) ?? []) stack.push(child)
  }
  return out
}

function pssKb(pid: number): number {
  try {
    const roll = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8")
    const m = roll.match(/^Pss:\s+(\d+) kB$/m)
    return m ? Number(m[1]) : 0
  } catch {
    return 0
  }
}

export function sampleTree(root: number, ms: number): Sample {
  const rows = readProcs()
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  const pids = treeOf(rows, root)
  let rssKb = 0
  let pssKb_ = 0
  for (const pid of pids) {
    rssKb += byPid.get(pid)?.rssKb ?? 0
    pssKb_ += pssKb(pid)
  }
  return { ms, procs: pids.length, rssKb, pssKb: pssKb_ }
}

export async function main(argv: string[]): Promise<number> {
  const at = argv.indexOf("--")
  if (at === -1 || at === argv.length - 1) {
    console.error("usage: tree-rss.ts [--interval MS] [--json FILE] -- <command> [args...]")
    return 1
  }
  const flags = argv.slice(0, at)
  const cmd = argv.slice(at + 1)
  const interval = Number(flags[flags.indexOf("--interval") + 1]) || 200
  const jsonPath = flags.includes("--json") ? flags[flags.indexOf("--json") + 1] : null

  const started = performance.now()
  const child = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" })
  const samples: Sample[] = []
  let running = true
  const poll = (async () => {
    while (running) {
      samples.push(sampleTree(child.pid, Math.round(performance.now() - started)))
      await Bun.sleep(interval)
    }
  })()
  const exitCode = await child.exited
  running = false
  await poll

  const peakRss = samples.reduce((a, s) => (s.rssKb > a.rssKb ? s : a), samples[0])
  const peakPss = samples.reduce((a, s) => (s.pssKb > a.pssKb ? s : a), samples[0])
  const report = {
    command: cmd,
    exitCode,
    wallMs: Math.round(performance.now() - started),
    intervalMs: interval,
    samples: samples.length,
    peakProcs: Math.max(...samples.map((s) => s.procs)),
    peakRssKb: peakRss?.rssKb ?? 0,
    peakRssAtMs: peakRss?.ms ?? 0,
    peakPssKb: peakPss?.pssKb ?? 0,
    peakPssAtMs: peakPss?.ms ?? 0,
  }
  if (jsonPath) {
    writeFileSync(jsonPath, `${JSON.stringify({ ...report, timeline: samples }, null, 2)}\n`)
  }
  console.error(JSON.stringify(report))
  return exitCode
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
