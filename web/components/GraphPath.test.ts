// GraphPath: the "why is this here" view. shortestPathTo is graded in
// web/lib/graph-path.test.ts — what is graded here is the WORDING and the
// controls, which is where this phase can most easily mislead:
//
//   - "a shortest path" vs "the only shortest path" (11% of real nodes have
//     more than one, so a definite article would be false far too often);
//   - unreachable, root, and not-found are three different sentences, none of
//     them a blank stage;
//   - the number on screen is the BFS distance, never a walk's indent depth.

import { beforeEach, describe, expect, test } from "bun:test"
import { buildGraphIndexes } from "../lib/indexes"
import type { GraphData, GraphNode } from "../lib/schema"
import { SCHEMA_VERSION } from "../lib/schema"
import { app } from "../lib/state.svelte"
import { fixtureGraphRefs, fixtureManifest } from "../testing/fixtures"
import { buttonsWithText, withMount } from "../testing/helpers"
import GraphPath from "./GraphPath.svelte"

const GID = "packages/x86_64-linux/hello"

const node = (
  name: string,
  outs: { name: string; path?: string }[] = [{ name: "out" }],
): GraphNode =>
  ({
    drvPath: `/nix/store/hash-${name}.drv`,
    name,
    system: "x86_64-linux",
    outputs: outs,
  }) as GraphNode

function graph(nodes: GraphNode[], edges: number[][], root = 0): GraphData {
  return {
    version: SCHEMA_VERSION,
    id: GID,
    root,
    extractedAt: "2026-07-29T06:52:37.030Z",
    nodes,
    edges,
    tiers: { presence: false, sizes: false, dryRun: false, substituters: false },
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.reduce((a, r) => a + r.length, 0),
      outputPathCount: 0,
      uniqueOutputPathCount: 0,
    },
    warnings: [],
  }
}

/** root -> a, b ; a -> z ; b -> z  — z has TWO shortest paths. */
const diamond = () => graph([node("root"), node("a"), node("b"), node("z")], [[1, 2], [3], [3], []])

function seed() {
  app.manifest = { ...fixtureManifest(), graphs: fixtureGraphRefs() }
  app.packages = {}
  app.configs = {}
  app.graphs = {}
  app.selection = null
}
beforeEach(seed)

const load = (data: GraphData) => {
  app.graphs = { [GID]: { data, indexes: buildGraphIndexes(data) } }
}

const base = (data: GraphData, i: number) => {
  const p = data.nodes[i]?.drvPath ?? ""
  return p.slice(p.lastIndexOf("/") + 1)
}

const mountPath = (drvBase: string, fn: (host: HTMLElement) => void) =>
  withMount(GraphPath, { graphId: GID, drvBase }, fn)

const text = (host: HTMLElement) => (host.textContent ?? "").replace(/\s+/g, " ")

describe("the three empty-ish cases are three different sentences", () => {
  test("a basename that is not in the graph says so, and does not fall back to the root", () => {
    const data = diamond()
    load(data)
    mountPath("deadbeef-not-here.drv", (host) => {
      expect(text(host)).toContain("is not found in this graph")
      // Not a blank stage, and NOT the root's own path rendered instead.
      expect(host.querySelector(".path")).toBe(null)
      expect(text(host)).not.toContain("shortest path")
    })
  })

  test("the root says why it is here without pretending to have a path", () => {
    const data = diamond()
    load(data)
    mountPath(base(data, 0), (host) => {
      expect(text(host)).toContain("This is the graph's root")
      expect(host.querySelector(".path")).toBe(null)
    })
  })

  test("an unreachable node is not confused with the root", () => {
    //  0 -> 1 ;  2 stands alone
    const data = graph([node("root"), node("a"), node("orphan")], [[1], [], []])
    load(data)
    mountPath(base(data, 2), (host) => {
      expect(text(host)).toContain("No path from the graph root")
      expect(text(host)).not.toContain("This is the graph's root")
    })
  })
})

describe("the article is load-bearing", () => {
  test("a node reachable two ways says 'A shortest path' and states the count", () => {
    const data = diamond()
    load(data)
    mountPath(base(data, 3), (host) => {
      const t = text(host)
      expect(t).toContain("A shortest path")
      expect(t).toContain("2 hops")
      expect(t).toContain("2 shortest paths of this length exist")
      expect(t).not.toContain("The only shortest path")
    })
  })

  test("a uniquely reachable node says 'The only shortest path' and states no count", () => {
    const data = diamond()
    load(data)
    mountPath(base(data, 1), (host) => {
      const t = text(host)
      expect(t).toContain("The only shortest path")
      expect(t).toContain("1 hop")
      expect(t).not.toContain("shortest paths of this length exist")
    })
  })

  test("an uncountable number of shortest paths is stated as a lower bound", () => {
    // A chain of k diamonds has 2^k shortest paths. Past the counting cap the
    // UI must say "more than N" rather than print a confidently wrong figure —
    // the alternative is a number that looks exact and is not.
    const k = 40
    const nodes: GraphNode[] = []
    const edges: number[][] = []
    for (let i = 0; i < k; i++) {
      const a = 3 * i
      nodes[a] = node(`hub${i}`)
      nodes[a + 1] = node(`left${i}`)
      nodes[a + 2] = node(`right${i}`)
      edges[a] = [a + 1, a + 2]
      edges[a + 1] = [a + 3]
      edges[a + 2] = [a + 3]
    }
    nodes[3 * k] = node("target")
    edges[3 * k] = []
    const data = graph(nodes, edges)
    load(data)
    mountPath(base(data, 3 * k), (host) => {
      const t = text(host)
      expect(t).toContain("A shortest path")
      expect(t).toContain("more than")
      expect(t).toContain("shortest paths of this length exist")
    })
  })

  test("the printed number is the BFS distance, not the number of rendered rows", () => {
    //  0 -> 1 -> 2 -> 3  and  0 -> 3 directly: distance 1, though 3 is also
    //  reachable at depth 3 by the longer route.
    const data = graph([node("root"), node("a"), node("b"), node("target")], [[1, 3], [2], [3], []])
    load(data)
    mountPath(base(data, 3), (host) => {
      expect(text(host)).toContain("1 hop")
      expect(host.querySelectorAll(".path li").length).toBe(2) // root + target
    })
  })
})

describe("the path renders as controls, not decoration", () => {
  test("every hop is a real button and only the last is aria-current", () => {
    const data = diamond()
    load(data)
    mountPath(base(data, 3), (host) => {
      const hops = [...host.querySelectorAll(".path li button")]
      expect(hops.length).toBe(3)
      for (const h of hops) expect(h.tagName).toBe("BUTTON")
      expect(hops.map((h) => h.getAttribute("aria-current"))).toEqual([null, null, "true"])
    })
  })

  test("clicking a hop selects that node by its BASENAME", () => {
    const data = diamond()
    load(data)
    mountPath(base(data, 3), (host) => {
      const first = host.querySelector(".path li button") as HTMLButtonElement
      first.click()
      expect(app.selection).toEqual({
        kind: "graphNode",
        graphId: GID,
        drvBase: base(data, 0),
      })
    })
  })

  test("nothing carries a positive tabindex", () => {
    const data = diamond()
    load(data)
    mountPath(base(data, 3), (host) => {
      for (const e of [...host.querySelectorAll("[tabindex]")])
        expect(Number(e.getAttribute("tabindex"))).toBeLessThanOrEqual(0)
    })
  })

  test("a hop whose outputs are all pathless still renders its name", () => {
    const data = graph(
      [node("root"), node("fetcher", [{ name: "out" }]), node("leaf")],
      [[1], [2], []],
    )
    load(data)
    mountPath(base(data, 2), (host) => {
      const t = text(host)
      expect(t).toContain("fetcher")
      expect(t).not.toContain("undefined")
    })
  })
})

describe("graph status is a stated condition, never an error page", () => {
  test("an id naming no graph in the manifest says so", () => {
    withMount(GraphPath, { graphId: "packages/x86_64-linux/nope", drvBase: "x.drv" }, (host) => {
      expect(text(host)).toContain("No dependency graph named")
    })
  })

  test("a graph that is not loaded offers the same 'may extract' opt-in", () => {
    mountPath("x.drv", (host) => {
      const btn = buttonsWithText(host, "dependency graph")[0]
      expect(btn?.tagName).toBe("BUTTON")
      expect(btn?.textContent).toContain("may extract")
    })
  })

  test("a loading slot says so; an errored one retries; a permanent one does not", () => {
    app.graphs = { [GID]: "loading" }
    mountPath("x.drv", (host) => expect(text(host)).toContain("Extracting dependency graph"))

    app.graphs = { [GID]: { error: "boom: graph failed" } }
    mountPath("x.drv", (host) => {
      expect(text(host)).toContain("boom: graph failed")
      expect(buttonsWithText(host, "retry").length).toBe(1)
      // A graph that failed to load is never presented as "no path".
      expect(text(host)).not.toContain("No path from the graph root")
    })

    app.graphs = { [GID]: { error: "graph not included in this export", permanent: true } }
    mountPath("x.drv", (host) => {
      expect(buttonsWithText(host, "retry").length).toBe(0)
    })
  })
})

describe("a custom store resolves too", () => {
  test("resolution uses the document's own storeDir, not a constant", () => {
    const data = diamond()
    const alt = {
      ...data,
      nodes: data.nodes.map((n) => ({
        ...n,
        drvPath: n.drvPath.replace("/nix/store/", "/alt/store/"),
      })),
    }
    load(alt)
    mountPath(base(alt, 3), (host) => {
      expect(text(host)).toContain("A shortest path")
      expect(text(host)).not.toContain("is not found in this graph")
    })
  })
})
