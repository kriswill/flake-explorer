<script lang="ts">
import { snapshotOf } from "../lib/graph-snapshot"
import type { GraphData } from "../lib/schema"
import Dot from "./Dot.svelte"

interface Props {
  data: GraphData
  /** Injectable so the timestamp wording is testable. */
  now?: number
}
const { data, now = Date.now() }: Props = $props()

const snap = $derived(snapshotOf(data.extractedAt, now))

/**
 * Every state the rows can render, marker included — an incomplete legend is
 * worse than none, because it implies exhaustiveness. The two measured states
 * carry their real markers; the two unmeasured ones carry none, which IS their
 * marker.
 */
const STATES = [
  { token: "--ok", hollow: false, dot: true, label: "in the store" },
  { token: "--ink-muted", hollow: true, dot: true, label: "not in your store" },
  { token: "", hollow: false, dot: false, label: "presence not collected" },
  { token: "", hollow: false, dot: false, label: "no output path recorded" },
]

/**
 * "as of", never "currently": the claim is about the moment of extraction, and
 * nothing here re-checks the store at render time.
 */
const presenceLine = $derived.by(() => {
  if (!data.tiers.presence) return "presence was not collected for this graph"
  if (!snap.absolute) return "presence as of an unrecorded time"
  if (snap.normalized)
    return `presence as of ${snap.absolute} (timestamp normalized — not a real capture time)`
  return `presence as of ${snap.absolute}${snap.relative ? ` — ${snap.relative}` : ""}`
})

const extractedLine = $derived.by(() => {
  if (!snap.absolute) return "graph extracted at an unrecorded time"
  if (snap.normalized)
    return `graph extracted — timestamp normalized (${snap.absolute}), so it is not meaningful`
  return `graph extracted ${snap.absolute}${snap.relative ? ` — ${snap.relative}` : ""}`
})

/**
 * stats.absentCount counts UNIQUE PATHS, not entries — measured gap of 7 on
 * both real documents that collect presence. Labelling it "paths" is the whole
 * point; a bare number would invite the reader to compare it against a count
 * of entries that is a different quantity.
 */
const absentLine = $derived.by(() => {
  const n = data.stats.absentCount
  if (n === undefined) return "output paths not in your store: not collected"
  return `${n.toLocaleString("en-US")} output paths not in your store`
})
</script>

<div class="legend">
  <ul>
    {#each STATES as s (s.label)}
      <li>
        {#if s.dot}
          <span class="marker" style="--c:var({s.token})"><Dot hollow={s.hollow} /></span>
        {:else}
          <span class="marker empty" aria-hidden="true"></span>
        {/if}
        <span>{s.label}</span>
      </li>
    {/each}
  </ul>
  <p class="muted">{presenceLine}</p>
  {#if !data.tiers.sizes}<p class="muted">sizes were not collected for this graph</p>{/if}
  <p class="muted">{absentLine}</p>
  <p class="muted">{extractedLine}</p>
</div>

<style>
  .legend {
    border: 1px solid var(--grid);
    border-radius: 6px;
    padding: 6px 8px;
    margin: 8px 0;
    font-size: var(--text-3xs);
  }
  ul {
    list-style: none;
    margin: 0 0 4px;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
  }
  li {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .marker {
    display: inline-flex;
    align-items: center;
  }
  .marker.empty {
    width: 0.65rem;
  }
  p {
    margin: 2px 0 0;
  }
  .muted {
    color: var(--ink-muted);
  }
</style>
