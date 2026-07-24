// Unified search over options, packages, files, and inputs. Pure functions:
// the SearchBox component assembles sources from loaded state and renders
// the result. Options exist only inside loaded config blobs (they are
// on-demand documents), so the corpus honestly reflects what is loaded —
// the dropdown's footer surfaces the configurations that are not.

import type { Manifest, OptionEntry } from "../lib/schema"
import type { Selection } from "./hash"

export interface SearchHit {
  label: string
  /** Secondary line: config id, setter/declarer, alias notes. */
  detail?: string
  sel: Selection
  customized?: boolean
}

export type SearchKind = "options" | "packages" | "files" | "inputs"

export interface SearchCategory {
  kind: SearchKind
  hits: SearchHit[]
  /** Total matches before capping — drives the "… and N more" row. */
  total: number
}

export interface OptionSource {
  configId: string
  options: OptionEntry[]
  /** Lowercased dotted locs, parallel to options (ConfigIndexes.optionLocsLower). */
  locsLower: string[]
}

/** Per-category caps: options carry the weight, the rest are quick jumps. */
const CAPS: Record<SearchKind, number> = { options: 20, packages: 8, files: 8, inputs: 6 }

/**
 * Match score, lower wins; null = no match. Exact text beats an exact
 * segment ("zsh"), beats a segment prefix ("hist" in histSize), beats a
 * bare substring.
 */
export function rankMatch(textLower: string, q: string): number | null {
  const i = textLower.indexOf(q)
  if (i < 0) return null
  if (textLower === q) return 0
  if (textLower.split(/[./]/).includes(q)) return 1
  if (i === 0 || textLower[i - 1] === "." || textLower[i - 1] === "/") return 2
  return 3
}

interface Scored {
  score: number
  hit: SearchHit
}

function top(scored: Scored[], cap: number): { hits: SearchHit[]; total: number } {
  scored.sort((a, b) => a.score - b.score || a.hit.label.length - b.hit.label.length)
  return { hits: scored.slice(0, cap).map((s) => s.hit), total: scored.length }
}

const basename = (file: string) => file.split("/").pop() ?? file

/** "set by <definer>" for customized options, "declared in <declarer>" otherwise. */
function optionDetail(configId: string, o: OptionEntry): string {
  if (o.customized && o.definitions.length > 0) {
    return `${configId} · set by ${basename(o.definitions[o.definitions.length - 1]!.file)}`
  }
  const decl = o.declarations[0]
  return decl ? `${configId} · declared in ${basename(decl.file)}` : configId
}

export function searchAll(
  qRaw: string,
  manifest: Manifest,
  sources: OptionSource[],
): SearchCategory[] {
  const q = qRaw.trim().toLowerCase()
  if (!q) return []

  const options: Scored[] = []
  for (const src of sources) {
    for (let i = 0; i < src.locsLower.length; i++) {
      const score = rankMatch(src.locsLower[i]!, q)
      if (score === null) continue
      const o = src.options[i]!
      options.push({
        // Customized options first within the same match quality.
        score: score * 2 + (o.customized ? 0 : 1),
        hit: {
          label: o.loc.join("."),
          detail: optionDetail(src.configId, o),
          sel: { kind: "option", configId: src.configId, loc: o.loc },
          customized: o.customized,
        },
      })
    }
  }

  const packages: Scored[] = []
  for (const p of manifest.packages) {
    const label = p.path.join(".")
    const score = rankMatch(label.toLowerCase(), q)
    if (score === null) continue
    packages.push({ score, hit: { label, sel: { kind: "output", path: p.path } } })
  }

  const files: Scored[] = []
  for (const f of manifest.files) {
    const score = rankMatch(f.relPath.toLowerCase(), q)
    if (score === null) continue
    files.push({ score, hit: { label: f.relPath, sel: { kind: "file", fileId: f.id } } })
  }

  const inputs: Scored[] = []
  for (const i of Object.values(manifest.inputs)) {
    // Transitive inputs join the corpus too — the label carries the full
    // parent/child name and the hit routes like any input; a "transitive" tag
    // in the detail line keeps them distinguishable from direct inputs.
    const names = [i.name, ...(i.aliases ?? [])]
    const scores = names
      .map((n) => rankMatch(n.toLowerCase(), q))
      .filter((s): s is number => s !== null)
    if (scores.length === 0) continue
    inputs.push({
      // Direct inputs sort ahead of transitive at equal match quality.
      score: Math.min(...scores) * 2 + (i.transitive ? 1 : 0),
      hit: {
        label: i.name,
        detail: i.transitive
          ? "transitive"
          : i.aliases?.length
            ? `aliases: ${i.aliases.join(", ")}`
            : undefined,
        sel: { kind: "input", name: i.name },
      },
    })
  }

  const categories: SearchCategory[] = (
    [
      ["options", options],
      ["packages", packages],
      ["files", files],
      ["inputs", inputs],
    ] as const
  )
    .map(([kind, scored]) => ({ kind, ...top(scored, CAPS[kind]) }))
    .filter((c) => c.total > 0)
  return categories
}

/** Flat hit list in display order, for keyboard navigation. */
export function flatHits(categories: SearchCategory[]): SearchHit[] {
  return categories.flatMap((c) => c.hits)
}
