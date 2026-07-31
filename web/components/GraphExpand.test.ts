// GraphExpand: the rendered half of a graph walk. buildGraphRows is graded in
// web/lib/graph-rows.test.ts — what is graded here is that the rows become
// real controls: expanders that announce their state, a "shown above" marker
// that is reachable rather than decorative, output names that never render as
// an empty string, and a truncation label that agrees with the rows above it.

import { describe, expect, test } from "bun:test"
import { flushSync } from "svelte"
import { buildGraphIndexes } from "../lib/indexes"
import type { GraphData, GraphNode, GraphNodeOutput } from "../lib/schema"
import { SCHEMA_VERSION } from "../lib/schema"
import { withMount } from "../testing/helpers"
import GraphExpand from "./GraphExpand.svelte"

const out = (name: string, path?: string): GraphNodeOutput =>
  path === undefined ? { name } : { name, path }

const node = (name: string, outputs: GraphNodeOutput[] = [out("out", `/nix/store/x-${name}`)]) =>
  ({ drvPath: `/nix/store/${name}.drv`, name, system: "x86_64-linux", outputs }) as GraphNode

function graph(nodes: GraphNode[], edges: number[][], root = 0): GraphData {
  return {
    version: SCHEMA_VERSION,
    id: "packages/x86_64-linux/default",
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

/** root -> bash, stdenv ;  bash -> zlib ;  stdenv -> zlib  (a diamond). */
function diamond() {
  return graph([node("root"), node("bash"), node("stdenv"), node("zlib")], [[1, 2], [3], [3], []])
}

const mountExpand = (data: GraphData, fn: (host: HTMLElement) => void, over = {}) =>
  withMount(
    GraphExpand,
    { data, indexes: buildGraphIndexes(data), anchor: data.root, dir: "deps", ...over },
    fn,
  )

const rowNames = (host: HTMLElement) =>
  [...host.querySelectorAll(".row .name")].map((e) => e.textContent?.trim())

const expanders = (host: HTMLElement) => [...host.querySelectorAll(".row .expand")]

describe("rows and expansion", () => {
  test("renders one row per child of the anchor, in adjacency order", () => {
    mountExpand(diamond(), (host) => {
      expect(rowNames(host)).toEqual(["bash", "stdenv"])
    })
  })

  test("an expander is a real button that announces its state and flips it", () => {
    mountExpand(diamond(), (host) => {
      const first = expanders(host)[0] as HTMLButtonElement
      expect(first.tagName).toBe("BUTTON")
      expect(first.getAttribute("aria-expanded")).toBe("false")

      first.click()
      flushSync()
      expect(
        (host.querySelectorAll(".row .expand")[0] as HTMLElement).getAttribute("aria-expanded"),
      ).toBe("true")
      // bash's one dependency is now on screen.
      expect(rowNames(host)).toEqual(["bash", "zlib", "stdenv"])
    })
  })

  test("the expander's accessible name carries the count and the scope", () => {
    mountExpand(diamond(), (host) => {
      const label = expanders(host)[0]?.getAttribute("aria-label") ?? ""
      expect(label).toContain("bash")
      expect(label).toContain("1")
      expect(label).toContain("within this graph")
    })
  })

  test("a childless node gets no expander at all", () => {
    // zlib is a leaf, so expanding stdenv reveals a row with nothing to open.
    mountExpand(diamond(), (host) => {
      ;(expanders(host)[1] as HTMLButtonElement).click()
      flushSync()
      const rows = [...host.querySelectorAll(".row")]
      const zlib = rows.find((r) => r.querySelector(".name")?.textContent?.trim() === "zlib")
      expect(zlib?.querySelector(".expand")).toBe(null)
    })
  })

  test("the dependents direction renders the transpose", () => {
    const data = diamond()
    mountExpand(data, (host) => expect(rowNames(host)).toEqual(["bash", "stdenv"]), {
      anchor: 3,
      dir: "dependents",
    })
  })
})

describe("repeats and cycles are visible, not silent", () => {
  test("a second occurrence renders a real 'shown above' button, not a dead glyph", () => {
    mountExpand(diamond(), (host) => {
      for (const e of expanders(host)) (e as HTMLButtonElement).click()
      flushSync()
      const repeat = host.querySelector(".row .repeat")
      expect(repeat?.tagName).toBe("BUTTON")
      expect(repeat?.textContent).toContain("shown above")
      // It is a control, so it is reachable: no tabindex removing it from order.
      expect(repeat?.getAttribute("tabindex")).toBe(null)
    })
  })

  test("a repeat is not expandable however it is reached", () => {
    mountExpand(diamond(), (host) => {
      for (const e of expanders(host)) (e as HTMLButtonElement).click()
      flushSync()
      const rows = [...host.querySelectorAll(".row")]
      const zlibRows = rows.filter((r) => r.querySelector(".name")?.textContent?.trim() === "zlib")
      expect(zlibRows.length).toBe(2)
      expect(zlibRows[1]?.querySelector(".expand")).toBe(null)
    })
  })

  test("a node on its own ancestor path says so in words, not in colour", () => {
    //  root -> a -> b -> a
    const data = graph([node("root"), node("a"), node("b")], [[1], [2], [1]])
    mountExpand(data, (host) => {
      ;(expanders(host)[0] as HTMLButtonElement).click()
      flushSync()
      ;(host.querySelectorAll(".row .expand")[1] as HTMLButtonElement).click()
      flushSync()
      const cycle = host.querySelector(".row .cycle")
      expect(cycle?.textContent).toContain("already on this path")
    })
  })
})

describe("outputs are named, never rendered blank", () => {
  test("every output of a multi-output node is named", () => {
    const data = graph(
      [
        node("root"),
        node("glibc", [
          out("out", "/nix/store/a"),
          out("dev", "/nix/store/b"),
          out("bin", "/nix/store/c"),
        ]),
      ],
      [[1], []],
    )
    mountExpand(data, (host) => {
      const outs = host.querySelector(".row .outs")?.textContent ?? ""
      expect(outs).toContain("out")
      expect(outs).toContain("dev")
      expect(outs).toContain("bin")
    })
  })

  test("a node whose outputs are all pathless still renders its name and expands", () => {
    // A `system: "builtin"` fetcher: outputs carry a name and no path at all.
    const data = graph([node("root"), node("source", [out("out")]), node("inner")], [[1], [2], []])
    mountExpand(data, (host) => {
      expect(rowNames(host)).toEqual(["source"])
      expect(host.querySelector(".row .outs")?.textContent).toContain("out")
      // Nothing renders as an empty parenthetical or the string "undefined".
      expect(host.textContent).not.toContain("undefined")
      const expander = expanders(host)[0] as HTMLButtonElement
      expect(expander.tagName).toBe("BUTTON")
      expander.click()
      flushSync()
      expect(rowNames(host)).toEqual(["source", "inner"])
    })
  })
})

describe("truncation is stated, never silent", () => {
  const wide = (n: number) =>
    graph(
      [node("root"), ...Array.from({ length: n }, (_, i) => node(`dep${i}`))],
      [Array.from({ length: n }, (_, i) => i + 1), ...Array(n).fill([])],
    )

  test("the label's numbers are the rows actually rendered and the true total", () => {
    mountExpand(
      wide(12),
      (host) => {
        const note = host.querySelector(".truncation")?.textContent ?? ""
        expect(note).toContain("12")
        expect(note).toContain(String(host.querySelectorAll(".row").length))
        expect(host.querySelectorAll(".row").length).toBe(5)
      },
      { budget: 5 },
    )
  })

  test("'show all' is a button and reveals the rest", () => {
    mountExpand(
      wide(12),
      (host) => {
        const all = host.querySelector(".truncation button") as HTMLButtonElement
        expect(all.tagName).toBe("BUTTON")
        all.click()
        flushSync()
        expect(host.querySelectorAll(".row").length).toBe(12)
        expect(host.querySelector(".truncation")).toBe(null)
      },
      { budget: 5 },
    )
  })

  test("no truncation note appears when nothing was dropped", () => {
    mountExpand(
      wide(3),
      (host) => {
        expect(host.querySelector(".truncation")).toBe(null)
      },
      { budget: 500 },
    )
  })
})

describe("keyboard reachability", () => {
  test("every control is a button, and none is removed from the tab order", () => {
    mountExpand(diamond(), (host) => {
      for (const e of expanders(host)) (e as HTMLButtonElement).click()
      flushSync()
      const controls = [...host.querySelectorAll(".expand, .repeat, .truncation button")]
      expect(controls.length).toBeGreaterThan(0)
      for (const c of controls) {
        expect(c.tagName).toBe("BUTTON")
        // No tabindex at all is the correct answer: natural order, nothing
        // hoisted above it and nothing hidden from it.
        expect(c.getAttribute("tabindex")).toBe(null)
      }
    })
  })

  test("no element carries a positive tabindex", () => {
    mountExpand(diamond(), (host) => {
      for (const e of [...host.querySelectorAll("[tabindex]")]) {
        expect(Number(e.getAttribute("tabindex"))).toBeLessThanOrEqual(0)
      }
    })
  })
})
