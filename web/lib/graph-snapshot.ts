/**
 * The extraction timestamp behind a presence claim.
 *
 * Presence is a snapshot: any garbage collection since capture invalidates it.
 * So a presence marker with no timestamp is an unfalsifiable claim about
 * *now*, and the timestamp has to travel with the claim rather than sit in a
 * corner of the page.
 *
 * The awkward case is real rather than hypothetical. The nixos system document
 * in this project's corpus carries `extractedAt: "1970-01-01T00:00:00.000Z"` —
 * not a 56-year-old capture but a determinism normalization, since the data
 * plan names `extractedAt` as the one byte-equivalence-volatile field. A UI
 * that renders that as decades of staleness is reporting an artefact of the
 * capture process as a fact about the reader's store.
 */

/** Exactly the normalized value: `Date.parse` of the epoch is 0. */
const EPOCH_SENTINEL = 0

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export interface Snapshot {
  /** "2026-07-29 06:52 UTC", or null when there is no usable timestamp. */
  absolute: string | null
  /** Coarse relative form. Null when absent, unparseable, or normalized. */
  relative: string | null
  /** The timestamp is the normalization sentinel and means nothing. */
  normalized: boolean
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"} ago`

/**
 * Coarse by design. Minutes/hours/days and nothing finer: the underlying fact
 * is "the store looked like this when we asked", and a seconds-precise
 * rendering would imply the store is being watched continuously.
 *
 * Rounds DOWN at every boundary, so it never overstates freshness, and clamps
 * a future timestamp to "just now" rather than rendering negative time — clock
 * skew between the extracting machine and the browser is ordinary.
 */
function relativeTo(then: number, now: number): string {
  const delta = now - then
  if (delta < MINUTE) return "just now"
  if (delta < HOUR) return plural(Math.floor(delta / MINUTE), "minute")
  if (delta < DAY) return plural(Math.floor(delta / HOUR), "hour")
  return plural(Math.floor(delta / DAY), "day")
}

/** "2026-07-29 06:52 UTC" — UTC because the document's time is not the reader's. */
function absoluteUtc(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`
}

/**
 * `now` is a parameter rather than `Date.now()` so this stays pure and the
 * epoch and boundary cases are testable at all.
 */
export function snapshotOf(extractedAt: string | undefined, now: number): Snapshot {
  if (extractedAt === undefined) return { absolute: null, relative: null, normalized: false }

  const ms = Date.parse(extractedAt)
  if (Number.isNaN(ms)) return { absolute: null, relative: null, normalized: false }

  if (ms === EPOCH_SENTINEL) {
    // Show the value, refuse to age it. "1970-01-01 00:00 UTC" beside a note
    // that it was normalized is honest; "56 years ago" is not.
    return { absolute: absoluteUtc(ms), relative: null, normalized: true }
  }

  return { absolute: absoluteUtc(ms), relative: relativeTo(ms, now), normalized: false }
}
