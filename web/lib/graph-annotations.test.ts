// graph-annotations: where the presence/size polarity lives.
//
// The rule this file exists to pin is that an output is in exactly ONE of four
// states, and that they are not interchangeable:
//
//   not-collected  the tier is off — NOBODY LOOKED
//   no-path        the output has no store path — NOTHING TO LOOK AT
//   in-store       measured present
//   not-in-store   measured absent — and this is the MAJORITY state on real
//                  data (78% / 77% of measured outputs), not the exception
//
// Measured on the real documents: no pathless output carries presence
// (591/591 and 695/695 exact correspondence), and no absent output carries
// sizes (0 of 29,918 entries across all three documents).
//
// Order-independent by construction: nothing here touches the app singleton,
// the DOM, or any global registry.

import { describe, expect, test } from "bun:test"
import { humanBytes, outputSizes, outputState } from "./graph-annotations"
import type { GraphNodeOutput, GraphTiers } from "./schema"

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

describe("the four states, and the order they are decided in", () => {
  test("tier off wins over everything the document happens to carry", () => {
    // A tier-off document should not carry presence at all — nebula carries
    // none on any of its 25,568 entries. But if a forward-compatible producer
    // ever emits one, the TIER is still the authority: we did not ask for it,
    // so we do not report it.
    const tiers = TIERS({ presence: false })
    expect(outputState(OUT(), tiers)).toBe("not-collected")
    expect(outputState(OUT({ present: true }), tiers)).toBe("not-collected")
    expect(outputState(OUT({ present: false }), tiers)).toBe("not-collected")
    expect(outputState(OUT({ path: undefined }), tiers)).toBe("not-collected")
  })

  test("a pathless output is never 'absent' — it has no path to be present at", () => {
    // 29.4% / 29.7% / 33.8% of real output entries are pathless. Calling them
    // absent would be a false measurement claim about roughly three in ten.
    expect(outputState(OUT({ path: undefined }), TIERS())).toBe("no-path")
    expect(outputState({ name: "out" }, TIERS())).toBe("no-path")
  })

  test("present and absent are read from the flag, not guessed from the path", () => {
    expect(outputState(OUT({ present: true }), TIERS())).toBe("in-store")
    expect(outputState(OUT({ present: false }), TIERS())).toBe("not-in-store")
  })

  test("a path with no flag falls to not-collected, never to a guess", () => {
    // Unreachable on all real data (presence is carried on exactly the
    // path-bearing entries when the tier is on). It exists so a
    // forward-compatible document cannot slide into a wrong state.
    expect(outputState(OUT(), TIERS())).toBe("not-collected")
  })

  test("the four states are exhaustive and mutually exclusive", () => {
    const tiers = [TIERS(), TIERS({ presence: false })]
    const outs = [
      OUT(),
      OUT({ present: true }),
      OUT({ present: false }),
      OUT({ path: undefined }),
      OUT({ path: undefined, present: true }),
    ]
    const seen = new Set<string>()
    for (const t of tiers) for (const o of outs) seen.add(outputState(o, t))
    expect([...seen].sort()).toEqual(["in-store", "no-path", "not-collected", "not-in-store"])
  })
})

describe("sizes render only where they were measured", () => {
  test("the sizes tier being off is 'not collected', not zero", () => {
    const s = outputSizes(
      OUT({ present: true, narSize: 10, closureSize: 20 }),
      TIERS({ sizes: false }),
    )
    expect(s.collected).toBe(false)
    expect(s.narSize).toBeUndefined()
    expect(s.closureSize).toBeUndefined()
  })

  test("a present output carries whatever sizes it has", () => {
    const s = outputSizes(OUT({ present: true, narSize: 1024, closureSize: 4096 }), TIERS())
    expect(s).toEqual({ collected: true, narSize: 1024, closureSize: 4096 })
  })

  test("an absent output has no sizes and does not invent zeroes", () => {
    // Measured: 0 entries carry a size while not present, across all three
    // real documents. If one ever does, that is an extractor bug — but the
    // renderer must not manufacture a 0 either way.
    const s = outputSizes(OUT({ present: false }), TIERS())
    expect(s.collected).toBe(true)
    expect(s.narSize).toBeUndefined()
    expect(s.closureSize).toBeUndefined()
  })

  test("a genuine zero-byte size is a MEASUREMENT and survives as one", () => {
    // The sharpest edge in the whole phase: 0 B measured must be
    // distinguishable from "not collected". No real document contains one.
    const s = outputSizes(OUT({ present: true, narSize: 0, closureSize: 0 }), TIERS())
    expect(s.collected).toBe(true)
    expect(s.narSize).toBe(0)
    expect(s.closureSize).toBe(0)
    expect(humanBytes(0)).toBe("0 B")
  })
})

/**
 * humanBytes moved here from PackageDetail.svelte:47 so there is one formatter
 * rather than two that can drift. The move must be OUTPUT-IDENTICAL, so these
 * expectations were captured by running the ORIGINAL implementation at
 * 19ee3e1 before the move — including its two quirks, which a rewrite would
 * quietly "fix": 10239 rounds up into "10.0 KB" while 10240 prints "10 KB",
 * and nothing scales past TB.
 */
describe("humanBytes is byte-identical to the implementation it replaces", () => {
  const BASELINE: [number, string][] = [
    [0, "0 B"],
    [1, "1 B"],
    [512, "512 B"],
    [1023, "1023 B"],
    [1024, "1.0 KB"],
    [1025, "1.0 KB"],
    [1536, "1.5 KB"],
    [10239, "10.0 KB"],
    [10240, "10 KB"],
    [121000, "118 KB"],
    [1048576, "1.0 MB"],
    [1073741824, "1.0 GB"],
    [1090910456, "1.0 GB"], // the largest real narSize
    [1769365176, "1.6 GB"], // the largest real closureSize, m6 packages
    [1810316408, "1.7 GB"], // the largest real closureSize, m6 devShells
    [1099511627776, "1.0 TB"],
    [1125899906842624, "1024 TB"], // no unit past TB — preserved deliberately
    [5000000000000000, "4547 TB"],
  ]

  for (const [n, expected] of BASELINE) {
    test(`${n} -> "${expected}"`, () => {
      expect(humanBytes(n)).toBe(expected)
    })
  }

  test("every value carries a unit", () => {
    for (const [n] of BASELINE) expect(humanBytes(n)).toMatch(/ (B|KB|MB|GB|TB)$/)
  })
})
