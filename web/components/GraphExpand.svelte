<script lang="ts">
import { SvelteSet } from "svelte/reactivity"
import type { Direction } from "../lib/graph-rows"
import { buildGraphRows } from "../lib/graph-rows"
import type { GraphIndexes } from "../lib/indexes"
import type { GraphData } from "../lib/schema"
import { app } from "../lib/state.svelte"
import OutputStatus from "./OutputStatus.svelte"

/**
 * One node in the system graph is depended on by 10,384 others — 55% of the
 * graph in a single list. A cap is therefore not optional; what IS optional is
 * hiding it, and this one never does: the count beside the rows comes off the
 * same walk that emitted them, and lifting the cap is the reader's explicit
 * choice, not a threshold the UI crosses on their behalf.
 */
const ROW_BUDGET = 500

interface Props {
  data: GraphData
  indexes: GraphIndexes
  /** Node the rows hang under. Not itself a row — the caller renders it. */
  anchor: number
  dir: Direction
  /** Row cap. Overridable so a test can reach the truncation path cheaply. */
  budget?: number
  /** Graph id, when rows should navigate. Omitted, names render as plain text. */
  graphId?: string
}
const { data, indexes, anchor, dir, budget = ROW_BUDGET, graphId }: Props = $props()

/**
 * Expansion state is node indices and nothing else — never a copy of graph
 * data, which would put an 18,765-node structure behind a deep proxy. Keying
 * by node rather than by route is sound because a node is rendered in full at
 * exactly one position per walk (see buildGraphRows).
 */
const open = new SvelteSet<number>()
let showAll = $state(false)
let rootEl = $state<HTMLElement | null>(null)

const cap = $derived(showAll ? Number.POSITIVE_INFINITY : budget)
const result = $derived(
  buildGraphRows(indexes, anchor, open, dir, cap, (i) => data.nodes[i]?.name ?? ""),
)
const noun = $derived(dir === "deps" ? "dependencies" : "dependents")

function toggle(node: number) {
  if (open.has(node)) open.delete(node)
  else open.add(node)
}

/** Route on the drv BASENAME — the key measured unique on real data. */
function selectNode(drvPath: string) {
  if (!graphId) return
  app.select({ kind: "graphNode", graphId, drvBase: drvPath.slice(drvPath.lastIndexOf("/") + 1) })
}

/**
 * A repeat is a real control, not a decoration: it moves the reader to the
 * occurrence rendered in full. A plain `#hash` anchor would have been the
 * natural markup, but the app routes on `location.hash`, so following one
 * would change the route out from under the reader.
 */
function focusFirst(key: string | undefined) {
  if (!key || !rootEl) return
  const target = rootEl.querySelector<HTMLElement>(`[data-key="${key}"]`)
  if (!target) return
  target.scrollIntoView?.({ block: "nearest" })
  target.focus()
}
</script>

<ul class="rows" bind:this={rootEl}>
  {#each result.rows as row (row.key)}
    {@const n = data.nodes[row.node]}
    {#if n}
      <li class="row" style="--depth:{row.depth}">
        <div class="rowline">
          <!-- Leading count column, flush left of the arrows and outside the
               indentation, so every row's count lines up in one gutter. The
               number is aria-hidden: the expander's accessible name already
               carries it, and reading it again before the name is noise. -->
          <span class="count" aria-hidden="true"
            >{row.kind === "primary" && row.childCount > 0 ? row.childCount : ""}</span
          >
          {#if row.kind === "primary" && row.childCount > 0}
            <button
              class="expand"
              aria-expanded={row.expanded}
              aria-label="{row.childCount} {noun} of {n.name} within this graph"
              onclick={() => toggle(row.node)}>{row.expanded ? "▾" : "▸"}</button
            >
          {:else}
            <span class="pad" aria-hidden="true"></span>
          {/if}
          {#if graphId}
            <!-- A real control, so it is reachable and announceable — the row
                 name is the entry point to the path view. -->
            <button
              class="name link mono"
              data-key={row.key}
              onclick={() => selectNode(n.drvPath)}>{n.name}</button
            >
          {:else}
            <!-- tabindex="-1": programmatically focusable so "shown above" has
                 somewhere to land, and deliberately NOT in the tab order — the
                 row's own expander is what a keyboard reaches. -->
            <span class="name mono" data-key={row.key} tabindex="-1">{n.name}</span>
          {/if}
          <!-- Each output carries its own presence state: presence is per-output,
               and a node-level summary would be an aggregate that can mislead.
               Inline only while collapsed — an unfurled node's pills move into
               the box below so its children read clean directly beneath it. -->
          {#if !row.expanded}
            <span class="outs">
              {#each n.outputs as o (o.name)}
                <OutputStatus output={o} tiers={data.tiers} />
              {/each}
            </span>
          {/if}
          <!-- Repeat and cycle are distinguished by WORDS. Neither meaning is
               carried by colour or by a glyph alone. -->
          {#if row.kind === "repeat"}
            <button class="repeat link" onclick={() => focusFirst(row.firstKey)}>shown above</button>
          {:else if row.kind === "cycle"}
            <span class="cycle muted">already on this path</span>
          {/if}
        </div>
        {#if row.expanded}
          <div class="outbox">
            <span class="outs">
              {#each n.outputs as o (o.name)}
                <OutputStatus output={o} tiers={data.tiers} />
              {/each}
            </span>
          </div>
        {/if}
      </li>
    {/if}
  {/each}
</ul>

{#if result.truncated > 0}
  <p class="truncation muted">
    showing {result.rows.length} of {result.total}
    <button class="link" onclick={() => (showAll = true)}>show all {result.total}</button>
  </p>
{/if}

<style>
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: var(--text-xs);
  }
  .row {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .rowline {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  /* Depth indents the arrow, not the row: the count gutter stays flush left. */
  .expand,
  .pad {
    width: 1em;
    flex: none;
    text-align: center;
    margin-left: calc(var(--depth) * 14px);
  }
  /* An unfurled node's own pills, boxed under its name (count gutter 4ch +
     two 6px gaps + 1em arrow), so the children below read as one clean list. */
  .outbox {
    border: 1px solid var(--grid);
    border-radius: 6px;
    padding: 4px 8px;
    margin: 0 0 2px calc(var(--depth) * 14px + 4ch + 1em + 12px);
    align-self: flex-start;
  }
  .expand {
    background: none;
    border: none;
    padding: 0;
    color: var(--ink-muted);
    cursor: pointer;
    font-size: var(--text-2xs);
  }
  .mono {
    font-family: ui-monospace, monospace;
  }
  .muted {
    color: var(--ink-muted);
  }
  .name {
    word-break: break-all;
  }
  .name:focus-visible {
    outline: 1px solid var(--link);
    outline-offset: 2px;
  }
  /* A navigable name is still a name: .link's smaller size is for the inline
     affordances ("shown above", "show all"), not for the row's own label. */
  .name.link {
    font-size: var(--text-xs);
  }
  .outs {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 2px 8px;
  }
  .count,
  .cycle {
    font-size: var(--text-3xs);
  }
  .count {
    flex: none;
    min-width: 4ch;
    text-align: right;
    font-family: ui-monospace, monospace;
    font-variant-numeric: tabular-nums;
    color: var(--ink-muted);
  }
  .link {
    background: none;
    border: none;
    padding: 0;
    color: var(--link);
    font-size: var(--text-3xs);
    cursor: pointer;
    text-align: left;
  }
  .link:hover {
    text-decoration: underline;
  }
  .truncation {
    margin: 6px 0 0;
    font-size: var(--text-3xs);
  }
</style>
