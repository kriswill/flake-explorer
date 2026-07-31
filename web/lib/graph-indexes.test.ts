// buildGraphIndexes: the one pass a loaded dependency graph pays. Everything
// P2/P3 ask of a graph (N-hop expansion, shortest path from the root) reads
// these structures, so the properties asserted here are the ones those
// traversals are allowed to assume.
//
// Order-independent by construction: buildGraphIndexes is pure and nothing
// here touches the app singleton, the DOM, or any global registry.

import { describe, expect, test } from "bun:test"
import { buildGraphIndexes, dependenciesOf, dependentsOf } from "./indexes"
import type { GraphData, GraphNode } from "./schema"
import { SCHEMA_VERSION } from "./schema"

const node = (name: string, outputs: GraphNode["outputs"] = []): GraphNode => ({
  drvPath: `/nix/store/${name}.drv`,
  name,
  system: "x86_64-linux",
  outputs,
})

/** A graph whose root is NOT index 0 — real roots are 909 / 845 / 10887. */
function graph(over: Partial<GraphData> = {}): GraphData {
  const nodes = [node("dep"), node("mid"), node("root"), node("leaf")]
  return {
    version: SCHEMA_VERSION,
    id: "packages/x86_64-linux/default",
    root: 2,
    extractedAt: "2026-07-29T06:52:37.030Z",
    nodes,
    //  root(2) -> mid(1), leaf(3);  mid(1) -> dep(0);  leaf(3) -> dep(0)
    edges: [[], [0], [1, 3], [0]],
    tiers: { presence: false, sizes: false, dryRun: false, substituters: false },
    stats: { nodeCount: 4, edgeCount: 4, outputPathCount: 0, uniqueOutputPathCount: 0 },
    warnings: [],
    ...over,
  }
}

describe("buildGraphIndexes — adjacency", () => {
  test("forward adjacency IS the document's own edges, never a copy", () => {
    // The extractor already emits exactly the array a traversal wants, and it
    // is validated in range below — copying it would cost ~0.5 MB on a system
    // graph to buy nothing. Identity, not just equality, is the claim.
    const data = graph()
    const gx = buildGraphIndexes(data)
    expect(gx.forward).toBe(data.edges)
    for (let i = 0; i < data.nodes.length; i++) {
      expect(dependenciesOf(gx, i)).toEqual(data.edges[i]!)
    }
  })

  test("reverse adjacency is exactly the transpose", () => {
    const data = graph()
    const gx = buildGraphIndexes(data)
    // dep(0) is depended on by mid(1) and leaf(3); mid(1) by root(2);
    // root(2) by nobody; leaf(3) by root(2).
    expect([...dependentsOf(gx, 0)]).toEqual([1, 3])
    expect([...dependentsOf(gx, 1)]).toEqual([2])
    expect([...dependentsOf(gx, 2)]).toEqual([])
    expect([...dependentsOf(gx, 3)]).toEqual([2])

    // The general property, both directions.
    for (let i = 0; i < data.nodes.length; i++) {
      for (const j of dependenciesOf(gx, i)) {
        expect([...dependentsOf(gx, j)]).toContain(i)
      }
      for (const j of dependentsOf(gx, i)) {
        expect(dependenciesOf(gx, j)).toContain(i)
      }
    }
  })

  test("reverse rows come out ascending, and the totals match", () => {
    // Ascending rows make P2's "depended on by" list render in a stable order
    // without a per-render sort; the fill pass walks i ascending, so it is
    // free rather than something a caller has to maintain.
    const data = graph({
      nodes: [node("a"), node("b"), node("c"), node("d")],
      edges: [[3], [3], [3], []],
      root: 0,
    })
    const gx = buildGraphIndexes(data)
    expect([...dependentsOf(gx, 3)]).toEqual([0, 1, 2])

    let forward = 0
    let reverse = 0
    for (let i = 0; i < data.nodes.length; i++) {
      forward += dependenciesOf(gx, i).length
      reverse += dependentsOf(gx, i).length
    }
    expect(reverse).toBe(forward)
  })

  test("dependentsOf is a zero-copy view, not a fresh array per call", () => {
    // P2 expands on click; allocating a row per call would turn an O(children)
    // lookup into per-render garbage on an 18k-node graph.
    const gx = buildGraphIndexes(graph())
    const view = dependentsOf(gx, 0)
    expect(view).toBeInstanceOf(Uint32Array)
    expect(view.buffer).toBe(gx.revTargets.buffer)
  })

  test("a node with no dependents and a node with no dependencies both read empty", () => {
    const gx = buildGraphIndexes(graph())
    expect(dependentsOf(gx, 2)).toHaveLength(0) // the root
    expect(dependenciesOf(gx, 0)).toHaveLength(0) // a sink
  })

  test("a single-node graph indexes without edges", () => {
    const gx = buildGraphIndexes(
      graph({
        nodes: [node("only")],
        edges: [[]],
        root: 0,
        stats: { nodeCount: 1, edgeCount: 0, outputPathCount: 0, uniqueOutputPathCount: 0 },
      }),
    )
    expect(gx.revOffsets).toHaveLength(2)
    expect(gx.revTargets).toHaveLength(0)
    expect([...dependentsOf(gx, 0)]).toEqual([])
  })
})

describe("buildGraphIndexes — path lookups", () => {
  test("drvPaths and output paths resolve to node indices", () => {
    const data = graph({
      nodes: [
        node("dep", [{ name: "out", path: "/nix/store/aaa-dep" }]),
        node("mid", [
          { name: "out", path: "/nix/store/bbb-mid" },
          { name: "dev", path: "/nix/store/ccc-mid-dev" },
        ]),
        node("root", [{ name: "out", path: "/nix/store/ddd-root" }]),
        node("leaf"),
      ],
    })
    const gx = buildGraphIndexes(data)
    expect(gx.byDrvPath.get("/nix/store/root.drv")).toBe(2)
    expect(gx.byDrvPath.get("/nix/store/leaf.drv")).toBe(3)
    expect(gx.byDrvPath.get("/nix/store/nothing.drv")).toBeUndefined()

    expect(gx.byOutputPath.get("/nix/store/aaa-dep")).toBe(0)
    expect(gx.byOutputPath.get("/nix/store/ccc-mid-dev")).toBe(1) // non-"out" outputs count
    expect(gx.byOutputPath.size).toBe(4)
  })

  test("pathless outputs are not indexed — a third of them have no path at all", () => {
    // `derivation show` emits fixed-output fetcher outputs as {hash, method}
    // with NO path (8,632 of 25,568 entries on a real system graph). Indexing
    // output.path unconditionally would key the map on undefined.
    const gx = buildGraphIndexes(
      graph({
        nodes: [
          node("dep", [{ name: "out" }]),
          node("mid", [{ name: "out", path: "/nix/store/bbb-mid" }, { name: "dev" }]),
          node("root", [{ name: "out" }]),
          node("leaf", []),
        ],
      }),
    )
    expect(gx.byOutputPath.size).toBe(1)
    expect(gx.byOutputPath.get("/nix/store/bbb-mid")).toBe(1)
    expect([...gx.byOutputPath.keys()].every((k) => typeof k === "string")).toBe(true)
    expect(gx.byOutputPath.has(undefined as never)).toBe(false)
  })

  test("a duplicated output path keeps the FIRST node, deterministically", () => {
    // True duplicates are rare but real (56 among 16,880 unique paths on the
    // nebula graph). Nodes are drvPath-sorted, so first-wins is stable across
    // reloads of the same document rather than whichever node came last.
    const gx = buildGraphIndexes(
      graph({
        nodes: [
          node("dep", [{ name: "out", path: "/nix/store/shared" }]),
          node("mid", [{ name: "out", path: "/nix/store/shared" }]),
          node("root"),
          node("leaf"),
        ],
      }),
    )
    expect(gx.byOutputPath.get("/nix/store/shared")).toBe(0)
    expect(gx.byOutputPath.size).toBe(1)
  })

  test("a node with zero outputs is still reachable by drvPath", () => {
    const gx = buildGraphIndexes(graph())
    expect(gx.byDrvPath.size).toBe(4)
    expect(gx.byOutputPath.size).toBe(0)
  })
})

describe("buildGraphIndexes — malformed documents are rejected, not limped along", () => {
  // Each of these is the exact mutation the guard exists for. Without the
  // throw the document loads and a renderer later dereferences nodes[NaN] or
  // nodes[999999] and dies with a bare TypeError far from the cause; with it,
  // the load lands in an error slot carrying a legible message.
  test("edges not aligned with nodes", () => {
    expect(() => buildGraphIndexes(graph({ edges: [[], [0], [1, 3]] }))).toThrow(
      /edges length 3 does not match nodes length 4/,
    )
  })

  test("a root index outside the node range", () => {
    expect(() => buildGraphIndexes(graph({ root: 4 }))).toThrow(/root index 4 is out of range/)
    expect(() => buildGraphIndexes(graph({ root: -1 }))).toThrow(/root index -1 is out of range/)
    expect(() => buildGraphIndexes(graph({ root: 1.5 }))).toThrow(/root index 1.5 is out of range/)
  })

  test("an edge target outside the node range", () => {
    expect(() => buildGraphIndexes(graph({ edges: [[], [0], [1, 9], [0]] }))).toThrow(
      /edge target 9 from node 2 is out of range/,
    )
    expect(() => buildGraphIndexes(graph({ edges: [[], [0], [1, -1], [0]] }))).toThrow(
      /edge target -1 from node 2 is out of range/,
    )
  })

  test("the message names the graph, so an error slot says which document failed", () => {
    expect(() => buildGraphIndexes(graph({ root: 99 }))).toThrow(/packages\/x86_64-linux\/default/)
  })
})

describe("buildGraphIndexes — shapes the schema permits but real data lacks", () => {
  // Measured: zero self-loops and zero cycles across all three real documents.
  // Nothing in the schema forbids either, and every P2/P3 traversal inherits
  // whatever this builder tolerates — so both are exercised here rather than
  // assumed away.
  test("a self-loop indexes and does not hang", () => {
    const gx = buildGraphIndexes(graph({ edges: [[], [1], [1], []], root: 2 }))
    expect([...dependentsOf(gx, 1)]).toEqual([1, 2])
    expect([...dependenciesOf(gx, 1)]).toEqual([1])
  })

  test("a cycle indexes, and a visited-set walk over the result terminates", () => {
    // 0 -> 1 -> 2 -> 0. The builder never recurses, so it cannot stack
    // overflow; this also demonstrates that the API it hands P2/P3 supports a
    // terminating walk in both directions.
    const data = graph({ edges: [[1], [2], [0], []], root: 0 })
    const gx = buildGraphIndexes(data)

    const walk = (from: number, next: (i: number) => ArrayLike<number>) => {
      const seen = new Set<number>([from])
      const stack = [from]
      while (stack.length) {
        const v = stack.pop()!
        const row = next(v)
        for (let k = 0; k < row.length; k++) {
          const w = row[k]!
          if (!seen.has(w)) {
            seen.add(w)
            stack.push(w)
          }
        }
      }
      return seen
    }
    expect(walk(0, (i) => dependenciesOf(gx, i))).toEqual(new Set([0, 1, 2]))
    expect(walk(0, (i) => dependentsOf(gx, i))).toEqual(new Set([0, 1, 2]))
  })

  test("a node without a system, and 'builtin', both index normally", () => {
    // "builtin" is not a platform (188 nodes on the nebula graph); `system` is
    // optional in the schema even though no real node omits it.
    const nodes = [node("dep"), node("mid"), node("root"), node("leaf")]
    nodes[0]!.system = "builtin"
    delete nodes[1]!.system
    const gx = buildGraphIndexes(graph({ nodes }))
    expect(gx.byDrvPath.size).toBe(4)
  })
})

describe("buildGraphIndexes — scale", () => {
  // The real target is 18,765 nodes / 133,288 edges. Shipping that document is
  // not an option (5 MB of real-machine data), so CI guards the SHAPE on a
  // synthetic graph of the same class; the wall-clock number on the real
  // document is measured out of band under the mission heavy-lock.
  test("a 20k-node / ~130k-edge graph indexes in one pass", () => {
    const N = 20_000
    const FANOUT = 7 // ~130k edges when trimmed by the ascending constraint
    const nodes: GraphNode[] = []
    const edges: number[][] = []
    for (let i = 0; i < N; i++) {
      nodes.push(node(`n${i}`, [{ name: "out", path: `/nix/store/p${i}` }]))
      const row: number[] = []
      for (let k = 1; k <= FANOUT; k++) {
        const t = i - k * 3
        if (t >= 0) row.push(t)
      }
      edges.push(row.sort((a, b) => a - b))
    }
    const edgeCount = edges.reduce((n, r) => n + r.length, 0)
    expect(edgeCount).toBeGreaterThan(130_000)

    const gx = buildGraphIndexes(
      graph({
        nodes,
        edges,
        root: N - 1,
        stats: {
          nodeCount: N,
          edgeCount,
          outputPathCount: N,
          uniqueOutputPathCount: N,
        },
      }),
    )
    expect(gx.revOffsets).toHaveLength(N + 1)
    expect(gx.revTargets).toHaveLength(edgeCount)
    expect(gx.byDrvPath.size).toBe(N)
    expect(gx.byOutputPath.size).toBe(N)

    // Transpose totals must agree — a fast-but-wrong fill would show up here.
    let reverse = 0
    for (let i = 0; i < N; i++) reverse += dependentsOf(gx, i).length
    expect(reverse).toBe(edgeCount)
    // Spot-check the transpose at a node in the interior.
    for (const j of dependenciesOf(gx, N - 1)) {
      expect([...dependentsOf(gx, j)]).toContain(N - 1)
    }
  })
})
