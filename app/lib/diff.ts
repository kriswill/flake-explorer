// Pure option-level comparison of two loaded configurations — "what does
// nebula set that mini doesn't?". No extraction needed: every ConfigData
// blob is self-contained, so this is a join over the two optionsByLoc
// indexes that buildConfigIndexes already built.

import type { ConfigData, OptionEntry } from "../../src/schema"
import type { ConfigIndexes } from "./indexes"

export type DiffKind =
  /** Customized in A; absent or defaulted in B. */
  | "only-a"
  | "only-b"
  /** Customized on both sides with different values. */
  | "differs"
  /** Customized on both sides with the same value. */
  | "equal"
  /** Both customized, but at least one value can't be compared (skipped/errored). */
  | "incomparable"

export interface DiffRow {
  loc: string
  kind: DiffKind
  a?: OptionEntry
  b?: OptionEntry
}

export interface DiffSide {
  data: ConfigData
  indexes: ConfigIndexes
}

/**
 * Comparable rendering of an option's value. Package-typed options carry
 * only drv names (valueNames) — those compare fine against each other, so
 * a systemPackages diff works even though the values themselves are
 * skipped. A skipped/errored value with no names is incomparable.
 */
function comparable(o: OptionEntry): string | null {
  if (o.valueNames) return JSON.stringify(o.valueNames)
  if (o.valueError || o.valueSkipped) return null
  return JSON.stringify(o.value ?? null)
}

/** True when this entry counts as "set" on its side of the diff. */
const isSet = (o: OptionEntry | undefined): o is OptionEntry => !!o?.customized

/**
 * One row per option customized on either side, sorted by loc. Options
 * neither side customizes are omitted entirely — with 15k options per
 * config, the defaults are noise, not signal.
 */
export function diffConfigs(a: DiffSide, b: DiffSide): DiffRow[] {
  const at = (side: DiffSide, loc: string): OptionEntry | undefined => {
    const i = side.indexes.optionsByLoc.get(loc)
    return i === undefined ? undefined : side.data.options[i]
  }

  const locs = new Set<string>()
  for (const o of a.data.options) if (o.customized) locs.add(o.loc.join("."))
  for (const o of b.data.options) if (o.customized) locs.add(o.loc.join("."))

  const rows: DiffRow[] = []
  for (const loc of locs) {
    const ea = at(a, loc)
    const eb = at(b, loc)
    const setA = isSet(ea)
    const setB = isSet(eb)
    let kind: DiffKind
    if (setA && !setB) kind = "only-a"
    else if (!setA && setB) kind = "only-b"
    else {
      const va = comparable(ea!)
      const vb = comparable(eb!)
      kind = va === null || vb === null ? "incomparable" : va === vb ? "equal" : "differs"
    }
    rows.push({ loc, kind, a: ea, b: eb })
  }
  return rows.sort((x, y) => x.loc.localeCompare(y.loc))
}

/** Short one-line rendering of a side's value for the table cell. */
export function cellText(o: OptionEntry | undefined): string {
  if (!o) return "—"
  if (!o.customized) return "(default)"
  if (o.valueNames) return o.valueNames.length ? o.valueNames.join("  ") : "(no packages)"
  if (o.valueError) return "⚠ failed to evaluate"
  if (o.valueSkipped) return "(value skipped)"
  return JSON.stringify(o.value) ?? "—"
}

/** Counts per kind, for the summary line. */
export function diffCounts(rows: DiffRow[]): Record<DiffKind, number> {
  const counts: Record<DiffKind, number> = {
    "only-a": 0,
    "only-b": 0,
    differs: 0,
    equal: 0,
    incomparable: 0,
  }
  for (const r of rows) counts[r.kind]++
  return counts
}
