// shortestPathTo: the primitive behind "why is this here".
//
// The properties graded here are the ones the view's WORDING depends on. Two
// of them are load-bearing in a way that is easy to miss:
//
//   - distance is the SHORTEST-PATH distance, never the depth at which some
//     walk happened to reach the node. On the real system graph those differ
//     by more than 2x (shortest depth 24, fully-unrolled render depth 51).
//   - pathCount is the number of DISTINCT shortest paths, not the number of
//     last hops. On real data 11% of nodes have more than one shortest path,
//     so the difference decides whether the UI may say "the" or must say "a".
//
// Order-independent by construction: nothing here touches the app singleton,
// the DOM, or any global registry.

import { describe, expect, test } from "bun:test"
import { shortestPathTo } from "./graph-path"
import { buildGraphIndexes } from "./indexes"
import type { GraphData, GraphNode } from "./schema"
import { SCHEMA_VERSION } from "./schema"

const node = (name: string): GraphNode => ({
  drvPath: `/nix/store/${name}.drv`,
  name,
  system: "x86_64-linux",
  outputs: [],
})

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

/**
 * An independent BFS, written from the adjacency list rather than from the
 * implementation, so it is able to disagree with it. Returns distances only —
 * the oracle answers "how far", the impl must answer "how far AND by which
 * route", and the route is then checked against the edges directly.
 */
function oracleDistances(edges: number[][], root: number): Map<number, number> {
  const d = new Map([[root, 0]])
  let frontier = [root]
  while (frontier.length) {
    const next: number[] = []
    for (const i of frontier)
      for (const t of edges[i] ?? [])
        if (!d.has(t)) {
          d.set(t, (d.get(i) as number) + 1)
          next.push(t)
        }
    frontier = next
  }
  return d
}

/** Assert that `hops` really is a walk along `edges` from root to target. */
function assertWalk(edges: number[][], hops: number[], root: number, target: number) {
  expect(hops[0]).toBe(root)
  expect(hops.at(-1)).toBe(target)
  for (let i = 0; i + 1 < hops.length; i++) {
    expect(edges[hops[i] as number]).toContain(hops[i + 1] as number)
  }
}

//      0
//     / \
//    1   2      DIAMOND: node 3 is 2 hops away by two distinct routes
//     \ /
//      3
const DIAMOND = [[1, 2], [3], [3], []]

describe("the path itself", () => {
  test("a direct dependency is one hop", () => {
    const p = shortestPathTo(indexes(DIAMOND), 0, 1)
    expect(p.hops).toEqual([0, 1])
    expect(p.distance).toBe(1)
    expect(p.reachable).toBe(true)
  })

  test("the reported hops are a real walk along the edges", () => {
    const gx = indexes(DIAMOND)
    for (const target of [1, 2, 3]) {
      const p = shortestPathTo(gx, 0, target)
      assertWalk(DIAMOND, p.hops, 0, target)
      expect(p.distance).toBe(p.hops.length - 1)
    }
  })

  test("distance agrees with an independent BFS on every node", () => {
    //       0
    //      / \
    //     1   2
    //     |   |
    //     3   4
    //      \ /
    //       5 -> 6
    const G = [[1, 2], [3], [4], [5], [5], [6], []]
    const gx = indexes(G)
    const oracle = oracleDistances(G, 0)
    for (let i = 0; i < G.length; i++) {
      const p = shortestPathTo(gx, 0, i)
      const expected = oracle.get(i)
      if (expected === undefined) throw new Error(`oracle says node ${i} is unreachable`)
      expect(p.distance).toBe(expected)
      // The root's own path is empty by definition — there is no hop to walk.
      if (i === 0) expect(p.hops).toEqual([])
      else assertWalk(G, p.hops, 0, i)
    }
  })

  test("a root that is not 0 is honoured — real roots are 909 / 845 / 10887", () => {
    //  2 -> 0 -> 1
    const p = shortestPathTo(indexes([[1], [], [0]], 2), 2, 1)
    expect(p.hops).toEqual([2, 0, 1])
    expect(p.distance).toBe(2)
  })

  test("a longer route is never preferred over a shorter one", () => {
    //  0 -> 1 -> 2 -> 3   and   0 -> 3 directly
    const p = shortestPathTo(indexes([[1, 3], [2], [3], []]), 0, 3)
    expect(p.distance).toBe(1)
    expect(p.hops).toEqual([0, 3])
  })
})

describe("the two empty cases are different, and say so", () => {
  test("root to itself is an empty path that is reachable", () => {
    const p = shortestPathTo(indexes(DIAMOND), 0, 0)
    expect(p.hops).toEqual([])
    expect(p.distance).toBe(0)
    expect(p.reachable).toBe(true)
  })

  test("an unreachable node is an empty path that is NOT reachable", () => {
    //  0 -> 1 ;  2 stands alone
    const p = shortestPathTo(indexes([[1], [], []]), 0, 2)
    expect(p.hops).toEqual([])
    expect(p.reachable).toBe(false)
  })

  test("the two cases are distinguishable without inspecting hops", () => {
    const gx = indexes([[1], [], []])
    expect(shortestPathTo(gx, 0, 0).reachable).toBe(true)
    expect(shortestPathTo(gx, 0, 2).reachable).toBe(false)
  })
})

describe("counting distinct shortest paths — what decides 'a' vs 'the'", () => {
  test("a unique route reports exactly one", () => {
    const p = shortestPathTo(indexes(DIAMOND), 0, 1)
    expect(p.pathCount).toBe(1)
    expect(p.pathCountCapped).toBe(false)
  })

  test("a diamond reports two, not one and not two last-hops-by-accident", () => {
    const p = shortestPathTo(indexes(DIAMOND), 0, 3)
    expect(p.distance).toBe(2)
    expect(p.pathCount).toBe(2)
  })

  test("counts DISTINCT PATHS, not immediate predecessors", () => {
    // Two stacked diamonds: 4 distinct shortest paths to node 6, but node 6
    // has only 2 immediate predecessors. An implementation that reported
    // predecessors would say 2 here and be wrong.
    //   0 -> 1,2 ;  1,2 -> 3 ;  3 -> 4,5 ;  4,5 -> 6
    const G = [[1, 2], [3], [3], [4, 5], [6], [6], []]
    const p = shortestPathTo(indexes(G), 0, 6)
    expect(p.distance).toBe(4)
    expect(p.pathCount).toBe(4)
  })

  test("only paths of the SHORTEST length are counted", () => {
    //  0 -> 1 -> 3  (2 hops)  and  0 -> 2 -> 4 -> 3  (3 hops, must not count)
    const G = [[1, 2], [3], [4], [], [3]]
    const p = shortestPathTo(indexes(G), 0, 3)
    expect(p.distance).toBe(2)
    expect(p.pathCount).toBe(1)
  })

  test("an unreachable node counts zero paths", () => {
    const p = shortestPathTo(indexes([[1], [], []]), 0, 2)
    expect(p.pathCount).toBe(0)
  })

  test("an explosive count is capped and SAYS it is capped", () => {
    // A chain of k diamonds has 2^k shortest paths. 40 diamonds is ~1e12 —
    // far past the cap, so the UI must be told the number is a lower bound
    // rather than shown a confidently wrong figure.
    const k = 40
    const edges: number[][] = []
    for (let i = 0; i < k; i++) {
      const a = 3 * i
      edges[a] = [a + 1, a + 2]
      edges[a + 1] = [a + 3]
      edges[a + 2] = [a + 3]
    }
    edges[3 * k] = []
    const p = shortestPathTo(indexes(edges), 0, 3 * k)
    expect(p.distance).toBe(2 * k)
    expect(p.pathCountCapped).toBe(true)
    expect(p.pathCount).toBeGreaterThan(0)
    expect(Number.isFinite(p.pathCount)).toBe(true)
  })
})

describe("determinism, termination, and stack safety", () => {
  test("the same inputs give a deep-equal result twice", () => {
    const gx = indexes(DIAMOND)
    expect(shortestPathTo(gx, 0, 3)).toEqual(shortestPathTo(gx, 0, 3))
  })

  test("a tie resolves to the lowest-index route, not an arbitrary one", () => {
    // Both 1 and 2 reach 3 in one hop; adjacency rows are ascending, so the
    // discovering parent is the lower index. Pinning it makes the choice a
    // property rather than an accident of iteration order.
    const p = shortestPathTo(indexes(DIAMOND), 0, 3)
    expect(p.hops).toEqual([0, 1, 3])
  })

  test("a cycle terminates", () => {
    //  0 -> 1 -> 2 -> 0, and 2 -> 3
    const p = shortestPathTo(indexes([[1], [2], [0, 3], []]), 0, 3)
    expect(p.hops).toEqual([0, 1, 2, 3])
    expect(p.distance).toBe(3)
  })

  test("a self-loop terminates", () => {
    const p = shortestPathTo(indexes([[1], [1, 2], []]), 0, 2)
    expect(p.distance).toBe(2)
  })

  test("a chain far deeper than any call stack resolves without overflowing", () => {
    // 50,000 deep: recursion dies here, an explicit loop does not. Real graphs
    // measure 21-24, but nothing in the schema bounds depth.
    const depth = 50_000
    const edges = Array.from({ length: depth }, (_, i) => (i + 1 < depth ? [i + 1] : []))
    const p = shortestPathTo(indexes(edges), 0, depth - 1)
    expect(p.distance).toBe(depth - 1)
    expect(p.hops.length).toBe(depth)
    expect(p.hops[0]).toBe(0)
    expect(p.hops.at(-1)).toBe(depth - 1)
    expect(p.pathCount).toBe(1)
  })
})
