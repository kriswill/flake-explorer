// The parts of an A/B that decide whether its numbers mean anything: the
// interleaving, the exclusive lock, and the summary arithmetic. The extraction
// itself is stubbed — a shell script that prints the timing lines the parser
// reads — so the whole suite runs in a second with no nix.

import { describe, expect, spyOn, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HeavyLock, type LegResult, legOrder, main, parseArgs, summarize } from "./bench-ab"

const ARMS = [
  { name: "main", binary: "/bin/true" },
  { name: "batch", binary: "/bin/true" },
]

describe("legOrder", () => {
  test("alternates arm order per rep so drift hits both", () => {
    expect(legOrder(ARMS, 2).map((l) => `${l.arm.name}${l.rep}`)).toEqual([
      "main1",
      "batch1",
      "batch2",
      "main2",
    ])
  })

  test("one rep is just the arms in order", () => {
    expect(legOrder(ARMS, 1).map((l) => l.arm.name)).toEqual(["main", "batch"])
  })

  test("does not mutate the caller's array", () => {
    const arms = [...ARMS]
    legOrder(arms, 4)
    expect(arms.map((a) => a.name)).toEqual(["main", "batch"])
  })
})

describe("HeavyLock", () => {
  test("one holder at a time, and the owner is recorded", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "lock-")), "heavy.lock")
    const a = new HeavyLock(dir, 10)
    const b = new HeavyLock(dir, 10)

    expect(await a.acquire("agent A")).toBe(true)
    expect(readFileSync(join(dir, "owner"), "utf8")).toContain("agent A")
    // B cannot take it while A holds it, and gives up rather than hanging.
    expect(await b.acquire("agent B", 50)).toBe(false)

    a.release()
    expect(existsSync(dir)).toBe(false)
    expect(await b.acquire("agent B", 50)).toBe(true)
    b.release()
  })

  test("a throwing body still releases — a crashed leg must not wedge the machine", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "lock-")), "heavy.lock")
    const lock = new HeavyLock(dir, 10)
    await expect(
      lock.withLock("boom", async () => {
        throw new Error("leg died")
      }),
    ).rejects.toThrow("leg died")
    expect(existsSync(dir)).toBe(false)
    // Still usable afterwards.
    expect(await lock.acquire("after", 50)).toBe(true)
    lock.release()
  })

  test("withLock reports a timeout instead of measuring anyway", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "lock-")), "heavy.lock")
    const holder = new HeavyLock(dir, 10)
    const waiter = new HeavyLock(dir, 10)
    await holder.acquire("holder")
    await expect(waiter.withLock("waiter", async () => "never", 50)).rejects.toThrow("in time")
    holder.release()
  })
})

describe("summarize", () => {
  const leg = (arm: string, l: "cold" | "warm", rep: number, wallMs: number): LegResult => ({
    arm,
    rep,
    leg: l,
    wallMs,
    exitCode: 0,
    cpuPercent: 700,
    peakRssKb: 10 * 1024 * 1024,
    peakPssKb: 9 * 1024 * 1024,
    peakProcs: 10,
    phases: { total: wallMs },
    dataDir: "/tmp/x",
  })

  test("one row per arm and leg, with the delta spelled out", () => {
    const md = summarize([
      leg("main", "cold", 1, 100_000),
      leg("main", "cold", 2, 100_000),
      leg("batch", "cold", 1, 80_000),
      leg("batch", "cold", 2, 80_000),
    ])
    expect(md).toContain("| main | cold | 2 | 100.00 |")
    expect(md).toContain("| batch | cold | 2 | 80.00 |")
    expect(md).toContain("10.00 GB")
    expect(md).toContain("batch is 20.0% faster than main")
  })

  test("a slower arm reads as negative, not as a silent win", () => {
    const md = summarize([leg("main", "cold", 1, 100_000), leg("batch", "cold", 1, 125_000)])
    expect(md).toContain("batch is -25.0% faster than main")
  })
})

describe("parseArgs", () => {
  test("takes two arms and a flake", () => {
    const o = parseArgs(["--flake", "/f", "--arm", "main=/a", "--arm", "batch=/b", "--reps", "3"])
    expect(o.flake).toBe("/f")
    expect(o.arms).toEqual([
      { name: "main", binary: "/a" },
      { name: "batch", binary: "/b" },
    ])
    expect(o.reps).toBe(3)
    expect(o.extractArgs).toEqual(["--all"])
  })

  test("refuses what it cannot compare", () => {
    expect(() => parseArgs([])).toThrow("--flake")
    expect(() => parseArgs(["--flake", "/f", "--arm", "main=/a"])).toThrow("two --arm")
    expect(() => parseArgs(["--flake", "/f", "--arm", "oops"])).toThrow("name=/path")
    expect(() =>
      parseArgs(["--flake", "/f", "--arm", "a=/a", "--arm", "b=/b", "--reps", "0"]),
    ).toThrow("--reps")
    expect(() => parseArgs(["--bogus"])).toThrow("unknown flag")
  })
})

describe("main", () => {
  /** Stand-in extractor: prints the timing lines the parser reads. */
  function stub(dir: string, name: string): string {
    const path = join(dir, name)
    writeFileSync(
      path,
      ["#!/bin/sh", 'echo "timing: manifest 10ms" >&2', 'echo "timing: total 40ms" >&2', ""].join(
        "\n",
      ),
    )
    chmodSync(path, 0o755)
    return path
  }

  test("runs both arms under the lock and writes an attributable report", async () => {
    const spies = [spyOn(console, "log"), spyOn(console, "error")].map((s) =>
      s.mockImplementation(() => {}),
    )
    const dir = mkdtempSync(join(tmpdir(), "bench-ab-"))
    const json = join(dir, "ab.json")
    const code = await main([
      "--flake",
      "/does/not/matter",
      "--arm",
      `main=${stub(dir, "fe-main")}`,
      "--arm",
      `batch=${stub(dir, "fe-batch")}`,
      "--reps",
      "1",
      "--interval",
      "25",
      "--out-root",
      join(dir, "out"),
      "--lock",
      join(dir, "heavy.lock"),
      "--json",
      json,
    ])
    for (const s of spies) s.mockRestore()

    expect(code).toBe(0)
    const report = JSON.parse(readFileSync(json, "utf8"))
    // One cold and one warm leg per arm, in interleaved order.
    expect(report.results.map((r: LegResult) => `${r.arm}-${r.leg}`)).toEqual([
      "main-cold",
      "main-warm",
      "batch-cold",
      "batch-warm",
    ])
    expect(report.results.every((r: LegResult) => r.exitCode === 0)).toBe(true)
    expect(report.results[0].phases).toEqual({ manifest: 10, total: 40 })
    // The lock is gone once the run is over.
    expect(existsSync(join(dir, "heavy.lock"))).toBe(false)
  })

  test("a failing extraction is reported, not averaged in silently", async () => {
    const spies = [spyOn(console, "log"), spyOn(console, "error")].map((s) =>
      s.mockImplementation(() => {}),
    )
    const dir = mkdtempSync(join(tmpdir(), "bench-ab-fail-"))
    const bad = join(dir, "fe-bad")
    writeFileSync(bad, "#!/bin/sh\nexit 3\n")
    chmodSync(bad, 0o755)
    const code = await main([
      "--flake",
      "/x",
      "--arm",
      `main=${stub(dir, "fe-main")}`,
      "--arm",
      `bad=${bad}`,
      "--reps",
      "1",
      "--interval",
      "25",
      "--out-root",
      join(dir, "out"),
    ])
    for (const s of spies) s.mockRestore()
    expect(code).toBe(1)
  })

  test("bad flags exit 1 rather than measuring nothing", async () => {
    const spy = spyOn(console, "error").mockImplementation(() => {})
    expect(await main(["--flake"])).toBe(1)
    spy.mockRestore()
  })
})
