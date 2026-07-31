<script lang="ts">
import { hasEmbedded, isStatic } from "../lib/data"
import { shortestPathTo } from "../lib/graph-path"
import { app, loadedGraph } from "../lib/state.svelte"
import AsyncSlot from "./AsyncSlot.svelte"
import GraphExpand from "./GraphExpand.svelte"
import GraphLegend from "./GraphLegend.svelte"
import OutputStatus from "./OutputStatus.svelte"

interface Props {
  graphId: string
  /** The derivation's store basename, straight off the route. */
  drvBase: string
}
const { graphId, drvBase }: Props = $props()

const graphRef = $derived(app.manifest?.graphs?.find((g) => g.id === graphId) ?? null)
const slot = $derived(graphRef ? app.graphs[graphId] : undefined)

/**
 * Static export with this graph not embedded: loading can never succeed, so
 * the page states that instead of offering a button whose only outcome is an
 * error. (A published demo's alias package hit exactly this.)
 */
const unloadable = $derived(graphRef !== null && isStatic() && !hasEmbedded(graphRef.dataFile))

/**
 * Resolution reconstructs the full drvPath from the carried storeDir. That is
 * deliberately the same operation the route's identity claim rests on, rather
 * than a second name-keyed index that could drift from it — and `storeDir`
 * comes from the document, so a custom store resolves too.
 */
function resolve(g: NonNullable<ReturnType<typeof loadedGraph>>): number | undefined {
  return g.indexes.byDrvPath.get(`${g.indexes.storeDir}/${drvBase}`)
}
</script>

{#if !graphRef}
  <!-- M7: an id that names no graph is a stated condition, not an error page. -->
  <p class="muted">No dependency graph named <span class="mono">{graphId}</span> in this export.</p>
{:else if !slot}
  <div class="head">
    <h2 class="mono">{drvBase}</h2>
  </div>
  {#if unloadable}
    <p class="muted">
      This derivation's path comes from the <span class="mono">{graphId}</span> dependency
      graph, which is not included in this export.
    </p>
  {:else}
    <p class="muted">
      This derivation's path comes from the <span class="mono">{graphId}</span> dependency graph,
      which is not loaded yet.
    </p>
    <button class="loadall" onclick={() => app.loadGraph(graphId)}>
      load the full dependency graph{isStatic() ? "" : " (may extract)"}
    </button>
  {/if}
{:else}
  <AsyncSlot
    value={slot}
    loadingText="Extracting dependency graph… (first run takes a while)"
    retry={() => app.retryGraph(graphId)}
  >
    {#snippet children(g)}
      {@const node = resolve(g)}
      <div class="head">
        <h2 class="mono">{node === undefined ? drvBase : g.data.nodes[node]?.name}</h2>
      </div>
      {#if node === undefined}
        <!-- M4: never a blank stage, never a silent fall back to the root. -->
        <p class="muted">
          <span class="mono">{drvBase}</span> is not found in this graph. It may belong to a
          different graph, or the graph may have been re-extracted since this link was made.
        </p>
      {:else}
        {@const p = shortestPathTo(g.indexes, g.data.root, node)}
        <GraphLegend data={g.data} />
        <section>
          <!-- No floating scope label on any heading here: the path summary
               sentence says "within this graph" in words, and every expander's
               accessible name carries the same boundary per count. -->
          <h3>Why is this here</h3>
          {#if !p.reachable}
            <!-- Distinct from the root case below: an empty path here means
                 the root cannot reach this node at all, not that it is zero
                 hops away. -->
            <p class="muted">
              No path from the graph root reaches this derivation. Nothing in this graph depends on
              it.
            </p>
          {:else if p.distance === 0}
            <p class="muted">
              This is the graph's root — it is here because you asked for it, not because something
              else needs it.
            </p>
          {:else}
            <nav aria-label="dependency path from the graph root">
              <ol class="path">
                {#each p.hops as hop, i (hop)}
                  {@const n = g.data.nodes[hop]}
                  {#if n}
                    <li>
                      <button
                        class="link mono"
                        aria-current={i === p.hops.length - 1 ? "true" : undefined}
                        onclick={() =>
                          app.select({
                            kind: "graphNode",
                            graphId,
                            drvBase: n.drvPath.slice(n.drvPath.lastIndexOf("/") + 1),
                          })}>{n.name}</button
                      >
                      <span class="outs">
                        {#each n.outputs as o (o.name)}
                          <OutputStatus output={o} tiers={g.data.tiers} />
                        {/each}
                      </span>
                    </li>
                  {/if}
                {/each}
              </ol>
            </nav>
            <!-- The article is load-bearing. 11% of reachable nodes on a real
                 system graph have more than one shortest path, one of them 888
                 of them, so "the shortest path" would be false far too often
                 to write. The count is stated rather than hidden. -->
            <p class="muted summary">
              {p.pathCount > 1 ? "A" : "The only"} shortest path — {p.distance}
              {p.distance === 1 ? "hop" : "hops"} within this graph{#if p.pathCount > 1}; {p.pathCountCapped
                  ? `more than ${p.pathCount.toLocaleString()}`
                  : p.pathCount.toLocaleString()} shortest paths of this length exist{/if}.
            </p>
          {/if}
        </section>

        <section>
          <h3>
            Depends on <span class="count">{g.indexes.forward[node]?.length ?? 0}</span>
          </h3>
          <GraphExpand data={g.data} indexes={g.indexes} anchor={node} dir="deps" {graphId} />
        </section>

        <section>
          <h3>
            Depended on by <span class="count"
              >{(g.indexes.revOffsets[node + 1] ?? 0) - (g.indexes.revOffsets[node] ?? 0)}</span
            >
          </h3>
          <GraphExpand data={g.data} indexes={g.indexes} anchor={node} dir="dependents" {graphId} />
        </section>
      {/if}
    {/snippet}
  </AsyncSlot>
{/if}

<style>
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
  }
  h2 {
    font-size: var(--text-lg);
    margin: 0;
    word-break: break-all;
  }
  h3 {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--text-xs);
    margin: 14px 0 4px;
  }
  section {
    margin-bottom: 10px;
  }
  .mono {
    font-family: ui-monospace, monospace;
  }
  .muted {
    color: var(--ink-muted);
  }
  .count {
    color: var(--ink-muted);
    font-weight: normal;
  }
  .path {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: var(--text-xs);
  }
  /* The chain reads downward, with a leading glyph per hop so the descent is
     carried by shape rather than by a colour. */
  .path li {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .path li::before {
    content: "↳";
    color: var(--ink-muted);
    font-size: var(--text-3xs);
  }
  .path li:first-child::before {
    content: "•";
  }
  .link {
    background: none;
    border: none;
    padding: 0;
    color: var(--link);
    font-size: var(--text-xs);
    cursor: pointer;
    text-align: left;
    word-break: break-all;
  }
  .link:hover {
    text-decoration: underline;
  }
  /* aria-current carries the meaning; the weight is a second channel, never
     the only one. */
  .link[aria-current="true"] {
    font-weight: 600;
  }
  .outs {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 2px 8px;
  }
  .summary {
    font-size: var(--text-3xs);
  }
  .summary {
    margin: 6px 0 0;
  }
  .loadall {
    margin-top: 6px;
    background: none;
    border: 1px solid var(--grid);
    border-radius: 6px;
    color: var(--ink-2);
    font-size: var(--text-2xs);
    padding: 3px 8px;
    cursor: pointer;
  }
  .loadall:hover {
    color: var(--link);
    border-color: var(--link);
  }
</style>
