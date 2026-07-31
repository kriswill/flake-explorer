// graph-snapshot: the timestamp that makes a presence claim falsifiable.
//
// Presence is a snapshot, invalidated by any GC since capture, so a presence
// marker with no timestamp is an unfalsifiable claim about *now*. Two cases
// decide the shape of this module and both are real, not hypothetical:
//
//   - the nixos system document's extractedAt is EXACTLY the epoch, because it
//     is a determinism-normalized capture. Rendering that as "56 years ago" or
//     colouring it as alarmingly stale would be reporting a normalization
//     artefact as a fact about the user's store.
//   - `now` is a parameter, not Date.now(). That is what makes any of this
//     testable, and it keeps the module pure like everything else in this lib.

import { describe, expect, test } from "bun:test"
import { snapshotOf } from "./graph-snapshot"

/** 2026-07-29T06:52:37.030Z — the real m6 packages extraction time. */
const REAL = "2026-07-29T06:52:37.030Z"
const REAL_MS = Date.parse(REAL)
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

describe("the epoch sentinel — a real document, not a hypothetical", () => {
  test("1970-01-01T00:00:00.000Z is flagged as normalized", () => {
    const s = snapshotOf("1970-01-01T00:00:00.000Z", REAL_MS)
    expect(s.normalized).toBe(true)
  })

  test("it suppresses the relative form entirely — never '56 years ago'", () => {
    const s = snapshotOf("1970-01-01T00:00:00.000Z", REAL_MS)
    expect(s.relative).toBe(null)
  })

  test("a real timestamp is NOT flagged as normalized", () => {
    expect(snapshotOf(REAL, REAL_MS + HOUR).normalized).toBe(false)
  })
})

describe("a missing timestamp is its own case", () => {
  test("undefined gives all-null and is not mistaken for the epoch", () => {
    const s = snapshotOf(undefined, REAL_MS)
    expect(s).toEqual({ absolute: null, relative: null, normalized: false })
  })

  test("an unparseable timestamp does not crash and does not invent a time", () => {
    const s = snapshotOf("not a date", REAL_MS)
    expect(s.absolute).toBe(null)
    expect(s.relative).toBe(null)
    expect(s.normalized).toBe(false)
  })

  test("the three empty-ish cases are distinguishable by their fields alone", () => {
    const missing = snapshotOf(undefined, REAL_MS)
    const epoch = snapshotOf("1970-01-01T00:00:00.000Z", REAL_MS)
    const real = snapshotOf(REAL, REAL_MS)
    expect([missing.normalized, epoch.normalized, real.normalized]).toEqual([false, true, false])
    expect([missing.absolute === null, epoch.absolute === null, real.absolute === null]).toEqual([
      true,
      false,
      false,
    ])
  })
})

describe("relative time is coarse and never claims false precision", () => {
  const rel = (deltaMs: number) => snapshotOf(REAL, REAL_MS + deltaMs).relative

  test("under a minute reads as just now, not as a second count", () => {
    expect(rel(30_000)).toBe("just now")
  })

  test("minutes, hours and days each get their own coarse form", () => {
    expect(rel(5 * MIN)).toBe("5 minutes ago")
    expect(rel(1 * MIN)).toBe("1 minute ago")
    expect(rel(3 * HOUR)).toBe("3 hours ago")
    expect(rel(1 * HOUR)).toBe("1 hour ago")
    expect(rel(2 * DAY)).toBe("2 days ago")
    expect(rel(1 * DAY)).toBe("1 day ago")
  })

  test("boundaries round down rather than up — never overstating freshness", () => {
    expect(rel(HOUR - 1)).toBe("59 minutes ago")
    expect(rel(DAY - 1)).toBe("23 hours ago")
  })

  test("a timestamp in the future does not render as negative time", () => {
    // Clock skew between the extracting machine and the browser is real.
    expect(rel(-5 * MIN)).toBe("just now")
  })

  test("the absolute form is always present when the timestamp parses", () => {
    const s = snapshotOf(REAL, REAL_MS + DAY)
    expect(s.absolute).toContain("2026-07-29")
    expect(s.absolute).toContain("UTC")
  })
})
