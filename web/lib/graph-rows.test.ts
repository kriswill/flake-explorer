// buildGraphRows: the walk every graph-backed expansion in the SPA renders
// through. It is a pure function of (indexes, anchor, open set, direction,
// budget), which is what makes "consistent between renders" a property rather
// than a hope — and what lets these tests grade it without mounting anything.
//
// The expectations checked here are the ones the UI is allowed to assume:
// document order is DFS pre-order, a node is rendered in full exactly once, a
// node on its own ancestor path is a dead end, and the reported total always
// agrees with the walk that produced the rows.
//
// Order-independent by construction: nothing here touches the app singleton,
// the DOM, or any global registry.

import { describe, expect, test } from "bun:test"
import type { Direction, GraphRow } from "./graph-rows"
import { buildGraphRows } from "./graph-rows"
import { buildGraphIndexes } from "./indexes"
import type { GraphData, GraphNode } from "./schema"
import { SCHEMA_VERSION } from "./schema"

const node = (name: string, outputs: GraphNode["outputs"] = []): GraphNode => ({
  drvPath: `/nix/store/${name}.drv`,
  name,
  system: "x86_64-linux",
  outputs,
})

/** A graph from an adjacency list; node i is named "n<i>". */
function indexes(edges: number[][], root = 0) {
  const data: GraphData = {
    version: SCHEMA_VERSION,
    id: "packages/x86_64-linux/default",
    root,
    extractedAt: "2026-07-29T06:52:37.030Z",
    nodes: edges.map((_, i) => node(`n${i}`)),
    edges,
    tiers: { presence: false, sizes: false, dryRun: false, substituters: false },
    stats: {
      nodeCount: edges.length,
      edgeCount: edges.reduce((a, r) => a + r.length, 0),
      outputPathCount: 0,
      uniqueOutputPathCount: 0,
    },
    warnings: [],
  }
  return buildGraphIndexes(data)
}

const NO_BUDGET = Number.POSITIVE_INFINITY
const keys = (rows: GraphRow[]) => rows.map((r) => r.key)
const ids = (rows: GraphRow[]) => rows.map((r) => r.node)
const open = (...n: number[]) => new Set(n)

/**
 * An independent pre-order walk, written from the adjacency list rather than
 * from the implementation, so it is able to disagree with it. Deliberately
 * recursive and deliberately naive — it is the oracle, not the shipped code.
 */
function oracle(
  edges: number[][],
  anchor: number,
  opened: ReadonlySet<number>,
  seen = new Set<number>(),
  path: number[] = [anchor],
): string[] {
  const out: string[] = []
  for (const child of edges[anchor] ?? []) {
    out.push(`${anchor}:${child}`)
    if (path.includes(child) || seen.has(child)) continue
    seen.add(child)
    if (opened.has(child)) out.push(...oracle(edges, child, opened, seen, [...path, child]))
  }
  return out
}

//      0
//     / \
//    1   2       DIAMOND: 3 is reachable by two routes
//     \ /
//      3
const DIAMOND = [[1, 2], [3], [3], []]

describe("buildGraphRows — shape of the walk", () => {
  test("with nothing open, the rows are the anchor's adjacency row in order", () => {
    const { rows, total, truncated } = buildGraphRows(
      indexes(DIAMOND),
      0,
      open(),
      "deps",
      NO_BUDGET,
    )
    expect(ids(rows)).toEqual([1, 2])
    expect(keys(rows)).toEqual(["0:1", "0:2"])
    expect(rows.map((r) => r.depth)).toEqual([0, 0])
    expect(total).toBe(2)
    expect(truncated).toBe(0)
  })

  test("childCount is exactly the number of rows the expander reveals", () => {
    const gx = indexes(DIAMOND)
    const collapsed = buildGraphRows(gx, 0, open(), "deps", NO_BUDGET)
    const one = collapsed.rows.find((r) => r.node === 1)
    if (!one) throw new Error("node 1 should be a child of the anchor")
    expect(one.childCount).toBe(1)
    expect(one.expanded).toBe(false)

    const expanded = buildGraphRows(gx, 0, open(1), "deps", NO_BUDGET)
    const revealed = expanded.rows.filter((r) => r.depth === 1)
    expect(revealed.length).toBe(one.childCount)
    expect(expanded.rows.find((r) => r.node === 1)?.expanded).toBe(true)
  })

  test("lastSibling marks only the final child of each parent", () => {
    const { rows } = buildGraphRows(indexes(DIAMOND), 0, open(1), "deps", NO_BUDGET)
    expect(rows.map((r) => [r.key, r.lastSibling])).toEqual([
      ["0:1", false],
      ["1:3", true],
      ["0:2", true],
    ])
  })

  test("row keys are unique within a walk, so they are safe as an {#each} key", () => {
    const gx = indexes([[1, 2], [3], [3], [4], []])
    const { rows } = buildGraphRows(gx, 0, open(1, 2, 3), "deps", NO_BUDGET)
    expect(new Set(keys(rows)).size).toBe(rows.length)
  })

  test("an anchor that is not 0 is walked from itself — real roots are 909 / 845 / 10887", () => {
    //  2 -> 0, 1
    const { rows } = buildGraphRows(indexes([[], [], [0, 1]], 2), 2, open(), "deps", NO_BUDGET)
    expect(keys(rows)).toEqual(["2:0", "2:1"])
  })

  test("an anchor with no children yields no rows", () => {
    const { rows, total } = buildGraphRows(indexes(DIAMOND), 3, open(), "deps", NO_BUDGET)
    expect(rows).toEqual([])
    expect(total).toBe(0)
  })
})

describe("buildGraphRows — agreement with an independent walk", () => {
  //      0
  //     / \
  //    1   2
  //    |   |
  //    3   4
  //     \ /
  //      5
  const WIDE = [[1, 2], [3], [4], [5], [5], []]

  for (const opened of [open(), open(1), open(1, 2), open(1, 2, 3, 4)]) {
    test(`depth-N expansion matches the oracle for open={${[...opened].join(",")}}`, () => {
      const { rows } = buildGraphRows(indexes(WIDE), 0, opened, "deps", NO_BUDGET)
      expect(keys(rows)).toEqual(oracle(WIDE, 0, opened))
    })
  }

  test("the dependents direction walks the transpose", () => {
    //  0 -> 2 ;  1 -> 2 ;  2 -> 3
    const gx = indexes([[2], [2], [3], []])
    // Who depends on 2? nodes 0 and 1, ascending.
    const { rows } = buildGraphRows(gx, 2, open(), "dependents", NO_BUDGET)
    expect(ids(rows)).toEqual([0, 1])
    // ...and who depends on 3? node 2, which is in turn depended on by 0 and 1.
    const deep = buildGraphRows(gx, 3, open(2), "dependents", NO_BUDGET)
    expect(keys(deep.rows)).toEqual(["3:2", "2:0", "2:1"])
  })

  test("the two directions are transposes of one another on the same graph", () => {
    const gx = indexes([[2], [2], [3], []])
    expect(ids(buildGraphRows(gx, 2, open(), "deps", NO_BUDGET).rows)).toEqual([3])
    expect(ids(buildGraphRows(gx, 3, open(), "dependents", NO_BUDGET).rows)).toEqual([2])
  })
})

describe("buildGraphRows — repeats and cycles are dead ends", () => {
  test("a diamond emits one primary and one repeat, and never descends into the repeat", () => {
    const gx = indexes(DIAMOND)
    const { rows } = buildGraphRows(gx, 0, open(1, 2, 3), "deps", NO_BUDGET)
    expect(keys(rows)).toEqual(["0:1", "1:3", "0:2", "2:3"])

    const first = rows.find((r) => r.key === "1:3")
    const second = rows.find((r) => r.key === "2:3")
    expect(first?.kind).toBe("primary")
    expect(second?.kind).toBe("repeat")
    // The repeat points at the occurrence that IS rendered in full, so the
    // "shown above" control has somewhere to send focus.
    expect(second?.firstKey).toBe("1:3")
    // Node 3 is open; only the primary may act on that.
    expect(first?.expanded).toBe(false) // 3 has no children in DIAMOND
    expect(second?.expanded).toBe(false)
  })

  test("a node on its own ancestor path is a cycle row, and the walk terminates", () => {
    //  0 -> 1 -> 2 -> 0
    const gx = indexes([[1], [2], [0]])
    const { rows, total } = buildGraphRows(gx, 0, open(0, 1, 2), "deps", NO_BUDGET)
    expect(keys(rows)).toEqual(["0:1", "1:2", "2:0"])
    expect(rows.at(-1)?.kind).toBe("cycle")
    expect(rows.at(-1)?.expanded).toBe(false)
    expect(total).toBe(3)
  })

  test("a self-loop is a cycle row on its own child", () => {
    //  0 -> 1 ;  1 -> 1
    const gx = indexes([[1], [1]])
    const { rows } = buildGraphRows(gx, 0, open(1), "deps", NO_BUDGET)
    expect(keys(rows)).toEqual(["0:1", "1:1"])
    expect(rows[1]?.kind).toBe("cycle")
  })

  test("opening a node cannot make the walk descend at a repeat occurrence", () => {
    //  0 -> 1, 2 ;  1 -> 3 ;  2 -> 3 ;  3 -> 4
    const gx = indexes([[1, 2], [3], [3], [4], []])
    const { rows } = buildGraphRows(gx, 0, open(1, 2, 3), "deps", NO_BUDGET)
    // 2:3 is the repeat, so node 4 appears under the primary occurrence only.
    expect(keys(rows)).toEqual(["0:1", "1:3", "3:4", "0:2", "2:3"])
  })

  test("row count stays bounded by the graph even with everything open", () => {
    // A complete digraph: unrolled without dedup this never terminates.
    const n = 6
    const gx = indexes(
      Array.from({ length: n }, (_, i) => [...Array(n).keys()].filter((j) => j !== i)),
    )
    const everything = new Set([...Array(n).keys()])
    const { rows, total } = buildGraphRows(gx, 0, everything, "deps", NO_BUDGET)
    // Every node is rendered in full at most once; the rest are repeat/cycle leaves.
    expect(rows.filter((r) => r.kind === "primary").length).toBeLessThanOrEqual(n)
    expect(total).toBe(rows.length)
    expect(rows.length).toBeLessThan(n * n)
  })
})

describe("buildGraphRows — purity and the truncation budget", () => {
  const WIDE = [[1, 2], [3], [4], [5], [5], []]

  test("the same inputs produce deep-equal rows", () => {
    const gx = indexes(WIDE)
    const a = buildGraphRows(gx, 0, open(1, 2, 3), "deps", NO_BUDGET)
    const b = buildGraphRows(gx, 0, open(1, 2, 3), "deps", NO_BUDGET)
    expect(a).toEqual(b)
  })

  test("a budget clips a prefix and reports what it dropped", () => {
    const gx = indexes(WIDE)
    const full = buildGraphRows(gx, 0, open(1, 2, 3, 4), "deps", NO_BUDGET)
    const clipped = buildGraphRows(gx, 0, open(1, 2, 3, 4), "deps", 3)

    expect(clipped.rows.length).toBe(3)
    expect(clipped.rows).toEqual(full.rows.slice(0, 3))
    // `total` is what the walk WOULD have emitted, so a "showing N of M" label
    // cannot disagree with the rows printed beside it.
    expect(clipped.total).toBe(full.total)
    expect(clipped.truncated).toBe(full.total - 3)
    expect(full.truncated).toBe(0)
  })

  test("a budget of 0 emits nothing but still counts honestly", () => {
    const { rows, total, truncated } = buildGraphRows(indexes(WIDE), 0, open(), "deps", 0)
    expect(rows).toEqual([])
    expect(total).toBe(2)
    expect(truncated).toBe(2)
  })

  test("a wide fan-out reports the true total, not the clipped one", () => {
    // 500 children of the anchor — the shape that makes a silent cap a lie.
    // Real worst case measured: 10,384 dependents on one nebula node.
    const fanout = 500
    const edges = [Array.from({ length: fanout }, (_, i) => i + 1), ...Array(fanout).fill([])]
    const { rows, total, truncated } = buildGraphRows(indexes(edges), 0, open(), "deps", 100)
    expect(rows.length).toBe(100)
    expect(total).toBe(fanout)
    expect(truncated).toBe(fanout - 100)
  })
})

describe("buildGraphRows — the walk does not recurse", () => {
  test("a chain far deeper than any call stack expands without overflowing", () => {
    // 50,000 deep: a recursive walk dies here, an explicit stack does not. Real
    // graphs measure 21-24 deep, but nothing in the schema bounds depth, and
    // P3's path view will inherit whatever this walk can survive.
    const depth = 50_000
    const edges = Array.from({ length: depth }, (_, i) => (i + 1 < depth ? [i + 1] : []))
    const gx = indexes(edges)
    const { rows, total } = buildGraphRows(
      gx,
      0,
      new Set([...Array(depth).keys()]),
      "deps",
      NO_BUDGET,
    )
    expect(rows.length).toBe(depth - 1)
    expect(total).toBe(depth - 1)
    expect(rows.at(-1)?.node).toBe(depth - 1)
    expect(rows.at(-1)?.depth).toBe(depth - 2)
  })
})

describe("buildGraphRows — direction is a parameter, not a copy of the code", () => {
  const DIRECTIONS: Direction[] = ["deps", "dependents"]

  test("both directions accept the same argument shape and return the same row type", () => {
    const gx = indexes([[1], [2], []])
    for (const dir of DIRECTIONS) {
      const { rows, total, truncated } = buildGraphRows(gx, 1, open(), dir, NO_BUDGET)
      expect(total).toBe(rows.length + truncated)
      for (const r of rows) {
        expect(typeof r.key).toBe("string")
        expect(r.depth).toBe(0)
        expect(["primary", "repeat", "cycle"]).toContain(r.kind)
      }
    }
  })
})
