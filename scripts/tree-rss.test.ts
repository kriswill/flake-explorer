// The tree walk and the /proc parse, pinned without assuming anything about
// what else is running on the machine. The sampling loop itself is exercised by
// running the script.

import { describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { main, readProcs, sampleTree, treeOf } from "./tree-rss"

describe("treeOf", () => {
  const rows = [
    { pid: 1, ppid: 0, rssKb: 100 },
    { pid: 10, ppid: 1, rssKb: 200 },
    { pid: 11, ppid: 10, rssKb: 300 },
    { pid: 12, ppid: 10, rssKb: 400 },
    { pid: 99, ppid: 1, rssKb: 500 },
  ]

  test("collects a root and every descendant, not its siblings", () => {
    expect(treeOf(rows, 10).sort()).toEqual([10, 11, 12])
  })

  test("a leaf is its own tree", () => {
    expect(treeOf(rows, 11)).toEqual([11])
  })

  test("a pid that is gone yields just itself, never a crash", () => {
    expect(treeOf(rows, 4242)).toEqual([4242])
  })
})

describe("readProcs", () => {
  test("finds this process, with a plausible parent and non-zero RSS", () => {
    const rows = readProcs()
    const self = rows.find((r) => r.pid === process.pid)
    expect(self).toBeDefined()
    expect(self?.ppid).toBeGreaterThan(0)
    // A running bun is several MB; the point is that the stat field offset is
    // right, which a zero would not prove.
    expect(self?.rssKb).toBeGreaterThan(1000)
  })

  test("survives a comm containing spaces or parens", () => {
    // Every row parsed above came through the same slice-after-last-')' path,
    // so a process named "(sd-pam)" or "Web Content" cannot shift the fields.
    // Assert the invariant that would break first: every ppid is a number.
    expect(readProcs().every((r) => Number.isInteger(r.ppid))).toBe(true)
  })
})

describe("sampleTree", () => {
  test("reports this process's own tree with both totals", () => {
    const s = sampleTree(process.pid, 0)
    expect(s.procs).toBeGreaterThanOrEqual(1)
    expect(s.rssKb).toBeGreaterThan(1000)
    expect(s.pssKb).toBeGreaterThan(0)
    // PSS divides shared pages, so for one process at one instant it cannot
    // exceed RSS — but the two totals come from different files read
    // microseconds apart, and a process growing in between can invert them.
    // Measured while writing this test: a growing `bun test` reported PSS
    // 124431 kB against RSS 123716 kB. The bound is therefore "same order",
    // not "<="; against a 10 GB extraction the skew is noise. See tree-rss.ts.
    expect(s.pssKb).toBeLessThan(s.rssKb * 1.5)
    expect(s.ms).toBe(0)
  })
})

describe("main", () => {
  function quiet() {
    return [spyOn(console, "error")].map((s) => s.mockImplementation(() => {}))
  }

  test("samples a child that holds memory and reports a peak", async () => {
    const spies = quiet()
    const dir = mkdtempSync(join(tmpdir(), "tree-rss-"))
    const json = join(dir, "r.json")
    // A child that allocates 64 MB and stays alive long enough to be sampled
    // several times at a 25ms interval.
    const code = await main([
      "--interval",
      "25",
      "--json",
      json,
      "--",
      "bun",
      "-e",
      "const a = new Uint8Array(64*1024*1024); a.fill(1); await Bun.sleep(300); process.exit(a[0])",
    ])
    for (const s of spies) s.mockRestore()

    expect(code).toBe(1)
    const report = JSON.parse(readFileSync(json, "utf8"))
    expect(report.samples).toBeGreaterThan(2)
    expect(report.peakProcs).toBeGreaterThanOrEqual(1)
    // The 64 MB the child allocated has to show up in the tree total.
    expect(report.peakRssKb).toBeGreaterThan(60_000)
    expect(report.timeline.length).toBe(report.samples)
  })

  test("refuses an invocation with nothing after --", async () => {
    const spies = quiet()
    const missing = await main(["--interval", "25"])
    const empty = await main(["--"])
    for (const s of spies) s.mockRestore()
    expect(missing).toBe(1)
    expect(empty).toBe(1)
  })
})
