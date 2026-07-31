/**
 * Presence and size polarity for a dependency graph's outputs.
 *
 * All of the phase's honesty rules live in this one file, deliberately: the
 * difference between "we did not look", "there is nothing to look at", "we
 * looked and it is there" and "we looked and it is gone" is easy to blur in
 * markup, and blurring it is how a UI ends up asserting a measurement it never
 * made. Deciding it once, in a pure function, is what keeps every renderer
 * honest without each of them having to remember.
 *
 * Measured on the real documents, and the reason the decision order is what it
 * is: a tier-off document carries presence on NONE of its 25,568 entries; a
 * pathless output carries presence on none either (591/591 and 695/695 exact
 * correspondence); and no absent output anywhere carries a size.
 */

import type { GraphNodeOutput, GraphTiers } from "./schema"

/**
 * The four states an output can be in. Exactly one applies.
 *
 * `not-in-store` is the MAJORITY on real data — 78% and 77% of measured
 * outputs on the two documents that collected presence — so it is the common
 * case a design has to read well for, not the exception.
 */
export type OutputState = "not-collected" | "no-path" | "in-store" | "not-in-store"

/**
 * Which state an output is in. The ORDER of these checks is the rule:
 *
 *  1. the tier is the authority — if presence was not collected, nothing the
 *     document happens to carry can turn that into a measurement;
 *  2. a pathless output has no path to be present at, so it is neither
 *     present nor absent;
 *  3. only then is the flag read.
 */
export function outputState(o: GraphNodeOutput, tiers: GraphTiers): OutputState {
  if (!tiers.presence) return "not-collected"
  if (o.path === undefined) return "no-path"
  if (o.present === true) return "in-store"
  if (o.present === false) return "not-in-store"
  // Tier on, path present, no flag: unreachable on every real document. A
  // forward-compatible producer could still emit it, and the honest answer is
  // that we do not know — never a guess in either direction.
  return "not-collected"
}

export interface OutputSizes {
  /** False when the sizes tier is off — "not collected", never 0 B. */
  collected: boolean
  narSize?: number
  closureSize?: number
}

/**
 * Sizes as measured, or nothing. A missing size is never coerced to 0: a
 * genuine `narSize: 0` is a measurement and has to stay distinguishable from
 * an absent one, which is the sharpest edge in this phase.
 */
export function outputSizes(o: GraphNodeOutput, tiers: GraphTiers): OutputSizes {
  if (!tiers.sizes) return { collected: false }
  const s: OutputSizes = { collected: true }
  if (o.narSize !== undefined) s.narSize = o.narSize
  if (o.closureSize !== undefined) s.closureSize = o.closureSize
  return s
}

/**
 * Byte formatting, moved here verbatim from PackageDetail so the codebase has
 * one formatter instead of two that can drift. Its behaviour is pinned by
 * baseline tests captured from the original before the move — including the
 * boundary where 10239 prints "10.0 KB" and 10240 prints "10 KB", and the fact
 * that nothing scales past TB. Those are not bugs to fix here; changing them
 * would be a rendering change smuggled in under a refactor.
 */
export function humanBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"]
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${i > 0 && v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}
