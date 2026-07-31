// OutputStatus: one output, one honest marker.
//
// What is graded here is that the four states are told apart by SHAPE and by
// WORDS, never by colour alone, and that no state invents a measurement:
// "not collected" must not look like "not in your store", and neither may
// render a size.

import { describe, expect, test } from "bun:test"
import type { GraphNodeOutput, GraphTiers } from "../lib/schema"
import { THEMES } from "../lib/themes"
import { withMount } from "../testing/helpers"
import OutputStatus from "./OutputStatus.svelte"

const TIERS = (over: Partial<GraphTiers> = {}): GraphTiers => ({
  presence: true,
  sizes: true,
  dryRun: false,
  substituters: false,
  ...over,
})
const OUT = (over: Partial<GraphNodeOutput> = {}): GraphNodeOutput => ({
  name: "out",
  path: "/nix/store/hash-thing",
  ...over,
})

const mountStatus = (output: GraphNodeOutput, tiers: GraphTiers, fn: (host: HTMLElement) => void) =>
  withMount(OutputStatus, { output, tiers }, fn)

const text = (h: HTMLElement) => (h.textContent ?? "").replace(/\s+/g, " ").trim()
const dot = (h: HTMLElement) => h.querySelector(".dot")
const marker = (h: HTMLElement) => h.querySelector("[role='img']")

describe("shape is the channel, not colour", () => {
  test("in the store: a SOLID dot", () => {
    mountStatus(OUT({ present: true }), TIERS(), (h) => {
      expect(dot(h)).not.toBe(null)
      expect(dot(h)?.classList.contains("hollow")).toBe(false)
    })
  })

  test("not in the store: a HOLLOW dot — a different shape, not just a different colour", () => {
    mountStatus(OUT({ present: false }), TIERS(), (h) => {
      expect(dot(h)).not.toBe(null)
      expect(dot(h)?.classList.contains("hollow")).toBe(true)
    })
  })

  test("not collected: NO dot at all — we have nothing to show", () => {
    mountStatus(OUT({ present: true }), TIERS({ presence: false }), (h) => {
      expect(dot(h)).toBe(null)
    })
  })

  test("no path: NO dot either, and it is not the same words as 'not collected'", () => {
    mountStatus(OUT({ path: undefined }), TIERS(), (h) => {
      expect(dot(h)).toBe(null)
    })
  })

  test("the two unmeasured states are textually distinct from each other", () => {
    let notCollected = ""
    let noPath = ""
    mountStatus(OUT({ present: true }), TIERS({ presence: false }), (h) => {
      notCollected = text(h)
    })
    mountStatus(OUT({ path: undefined }), TIERS(), (h) => {
      noPath = text(h)
    })
    expect(notCollected).not.toBe(noPath)
    expect(notCollected).toContain("not collected")
    expect(noPath).toContain("no output path")
  })

  test("'not collected' is textually distinct from 'not in your store'", () => {
    // The difference between "we did not look" and "we looked and it is gone".
    let uncollected = ""
    let absent = ""
    mountStatus(OUT(), TIERS({ presence: false }), (h) => {
      uncollected = text(h)
    })
    mountStatus(OUT({ present: false }), TIERS(), (h) => {
      absent = text(h)
    })
    expect(uncollected).not.toBe(absent)
  })
})

describe("the state reaches assistive tech as text", () => {
  test("a marker carries an accessible name naming the state", () => {
    mountStatus(OUT({ present: true }), TIERS(), (h) => {
      expect(marker(h)?.getAttribute("aria-label")).toContain("in the store")
    })
    mountStatus(OUT({ present: false }), TIERS(), (h) => {
      expect(marker(h)?.getAttribute("aria-label")).toContain("not in your store")
    })
  })

  test("the output's own name is always rendered", () => {
    for (const [o, t] of [
      [OUT({ present: true }), TIERS()],
      [OUT({ present: false }), TIERS()],
      [OUT({ path: undefined }), TIERS()],
      [OUT(), TIERS({ presence: false })],
    ] as const) {
      mountStatus(o, t, (h) => expect(text(h)).toContain("out"))
    }
  })

  test("nothing renders the string 'undefined'", () => {
    mountStatus(OUT({ path: undefined }), TIERS(), (h) => {
      expect(text(h)).not.toContain("undefined")
    })
  })
})

describe("sizes are rendered only where they were measured", () => {
  test("a present output shows nar and closure, each LABELLED", () => {
    mountStatus(OUT({ present: true, narSize: 123_456, closureSize: 5_000_000 }), TIERS(), (h) => {
      const t = text(h)
      expect(t).toContain("nar 121 KB")
      expect(t).toContain("closure 4.8 MB")
    })
  })

  test("an absent output shows no size and no zero", () => {
    mountStatus(OUT({ present: false }), TIERS(), (h) => {
      const t = text(h)
      expect(t).not.toContain("0 B")
      expect(t).not.toContain("nar ")
    })
  })

  test("the sizes tier being off says so rather than showing 0 B", () => {
    mountStatus(OUT({ present: true, narSize: 999 }), TIERS({ sizes: false }), (h) => {
      const t = text(h)
      expect(t).not.toContain("0 B")
      expect(t).toContain("sizes not collected")
    })
  })

  test("a genuine zero-byte size renders as a measurement", () => {
    mountStatus(OUT({ present: true, narSize: 0, closureSize: 0 }), TIERS(), (h) => {
      expect(text(h)).toContain("nar 0 B")
    })
  })
})

describe("theming", () => {
  test("no hard-coded colour in the rendered markup", () => {
    mountStatus(OUT({ present: true }), TIERS(), (h) => {
      expect(h.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(h.innerHTML).not.toMatch(/rgba?\(/)
    })
  })

  test("the colour it does set comes from a token defined in BOTH themes", () => {
    // The marker sets --c from a theme token; a dark-only choice fails here
    // because both stops are asserted to define it.
    mountStatus(OUT({ present: true }), TIERS(), (h) => {
      const style = (h.querySelector("[style]") as HTMLElement | null)?.getAttribute("style") ?? ""
      const token = style.match(/var\((--[a-z0-9-]+)\)/)?.[1]
      expect(token).not.toBeUndefined()
      for (const theme of THEMES) {
        expect(Object.keys(theme.vars)).toContain(token as string)
      }
    })
  })
})
