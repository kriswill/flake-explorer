// GraphLegend: the key to the markers, and the timestamp that makes a
// presence claim falsifiable.
//
// Two criteria drive this component and both are about completeness rather
// than decoration: a legend that documents only some of the states the UI can
// render is worse than none, because it implies exhaustiveness; and a presence
// marker with no timestamp is an unfalsifiable claim about *now*.

import { describe, expect, test } from "bun:test"
import type { GraphData, GraphStats, GraphTiers } from "../lib/schema"
import { SCHEMA_VERSION } from "../lib/schema"
import { withMount } from "../testing/helpers"
import GraphLegend from "./GraphLegend.svelte"

const NOW = Date.parse("2026-07-29T09:52:37.030Z") // 3h after the real capture

function graph(
  tiers: Partial<GraphTiers>,
  stats: Partial<GraphStats> = {},
  extractedAt = "2026-07-29T06:52:37.030Z",
): GraphData {
  return {
    version: SCHEMA_VERSION,
    id: "packages/x86_64-linux/default",
    root: 0,
    extractedAt,
    nodes: [{ drvPath: "/nix/store/a.drv", name: "a", outputs: [] }],
    edges: [[]],
    tiers: { presence: true, sizes: true, dryRun: false, substituters: false, ...tiers },
    stats: {
      nodeCount: 1,
      edgeCount: 0,
      outputPathCount: 0,
      uniqueOutputPathCount: 0,
      ...stats,
    },
    warnings: [],
  }
}

const mountLegend = (data: GraphData, fn: (h: HTMLElement) => void) =>
  withMount(GraphLegend, { data, now: NOW }, fn)

const text = (h: HTMLElement) => (h.textContent ?? "").replace(/\s+/g, " ").trim()

describe("completeness — the legend names every state the UI can render", () => {
  test("all four states appear, including the two that have no marker", () => {
    mountLegend(graph({}), (h) => {
      const t = text(h)
      expect(t).toContain("in the store")
      expect(t).toContain("not in your store")
      expect(t).toContain("not collected")
      expect(t).toContain("no output path")
    })
  })

  test("each marked state shows its ACTUAL marker, so the key matches the rows", () => {
    mountLegend(graph({}), (h) => {
      const dots = [...h.querySelectorAll(".dot")]
      expect(dots.length).toBe(2) // exactly the two measured states
      expect(dots.filter((d) => d.classList.contains("hollow")).length).toBe(1)
      expect(dots.filter((d) => !d.classList.contains("hollow")).length).toBe(1)
    })
  })
})

describe("tier status and the presence timestamp", () => {
  test("with the presence tier ON, presence is dated — 'as of', never 'currently'", () => {
    mountLegend(graph({}), (h) => {
      const t = text(h)
      expect(t).toContain("presence as of")
      expect(t).toContain("2026-07-29")
      expect(t).toContain("3 hours ago")
      expect(t).not.toContain("currently")
    })
  })

  test("with the presence tier OFF, no timestamped presence claim is made at all", () => {
    mountLegend(graph({ presence: false, sizes: false }), (h) => {
      const t = text(h)
      expect(t).not.toContain("presence as of")
      expect(t).toContain("presence was not collected")
    })
  })

  test("the extraction time is still shown as a fact about the document", () => {
    mountLegend(graph({ presence: false, sizes: false }), (h) => {
      expect(text(h)).toContain("graph extracted")
    })
  })

  test("the epoch document says the timestamp is not meaningful, and does not age it", () => {
    // The real nixos system document. "20663 days ago" would report a
    // normalization artefact as a fact about the reader's store.
    mountLegend(graph({ presence: false, sizes: false }, {}, "1970-01-01T00:00:00.000Z"), (h) => {
      const t = text(h)
      expect(t).toContain("normalized")
      expect(t).not.toMatch(/\d+ days ago/)
      expect(t).not.toContain("years ago")
    })
  })

  test("the sizes tier being off is stated separately from presence", () => {
    mountLegend(graph({ presence: true, sizes: false }), (h) => {
      expect(text(h)).toContain("sizes were not collected")
    })
  })
})

describe("counts are labelled by their own denominator", () => {
  test("absentCount is labelled as output PATHS, because that is what it counts", () => {
    // Measured gap on real data: 1,096 unique paths vs 1,103 entries on m6
    // packages, and 1,267 vs 1,274 on devShells. Labelling one as the other
    // is the failure this guards.
    mountLegend(graph({}, { absentCount: 1096 }), (h) => {
      const t = text(h)
      expect(t).toContain("1,096")
      expect(t).toContain("output paths")
      expect(t).not.toContain("entries")
    })
  })

  test("an ABSENT absentCount renders 'not collected', never 0", () => {
    // The nebula negative control: it carries no absentCount at all.
    mountLegend(graph({ presence: false, sizes: false }), (h) => {
      const t = text(h)
      expect(t).not.toMatch(/\b0 output paths\b/)
      expect(t).toContain("not collected")
    })
  })

  test("a genuine zero absentCount is a measurement and renders as 0", () => {
    // Tier on, nothing absent: a satisfied closure. Distinct from "absent".
    mountLegend(graph({}, { absentCount: 0 }), (h) => {
      expect(text(h)).toContain("0 output paths")
    })
  })
})

describe("theming", () => {
  test("no hard-coded colour in the rendered markup", () => {
    mountLegend(graph({}), (h) => {
      expect(h.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(h.innerHTML).not.toMatch(/rgba?\(/)
    })
  })
})
