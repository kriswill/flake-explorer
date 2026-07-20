<!-- Flat two-column option diff between two configurations: "what does
     nebula set that mini doesn't?". Pure client-side over two loaded
     ConfigData blobs (lib/diff.ts) — no extraction beyond loading each. -->
<script lang="ts">
import { cellText, type DiffRow, diffConfigs, diffCounts } from "../lib/diff"
import { app, configError, loadedConfig } from "../lib/state.svelte"
import AsyncSlot from "./AsyncSlot.svelte"

interface Props {
  a: string
  b: string
}
const { a, b }: Props = $props()

const sideA = $derived(loadedConfig(app.configs[a]))
const sideB = $derived(loadedConfig(app.configs[b]))

const rows = $derived(sideA && sideB ? diffConfigs(sideA, sideB) : [])
const counts = $derived(diffCounts(rows))

/** Equal rows are hidden behind the shared ?all= toggle; ?q= filters locs. */
const visible = $derived.by(() => {
  const q = app.q.toLowerCase()
  return rows.filter(
    (r) => (app.showAll || r.kind !== "equal") && (q === "" || r.loc.toLowerCase().includes(q)),
  )
})

/** Rendering thousands of rows helps nobody — cap and say so honestly. */
const CAP = 500
const shown = $derived(visible.slice(0, CAP))

const KIND_LABEL: Record<DiffRow["kind"], string> = {
  "only-a": "only A",
  "only-b": "only B",
  differs: "differs",
  equal: "same",
  incomparable: "not comparable",
}

const sides = $derived([
  { id: a, slot: app.configs[a], label: "A" },
  { id: b, slot: app.configs[b], label: "B" },
])
</script>

<h2 class="mono">{a} ↔ {b}</h2>
<p class="crumb">
  comparing customized options ·
  <button class="link mono" onclick={() => app.select({ kind: "config", configId: a })}>{a}</button>
  ·
  <button class="link mono" onclick={() => app.select({ kind: "config", configId: b })}>{b}</button>
</p>

{#each sides as s (s.id)}
  {#if !loadedConfig(s.slot)}
    <div class="load">
      <span class="mono">{s.label}: {s.id}</span>
      {#if !s.slot}
        <button class="link" onclick={() => void app.loadConfig(s.id)}>load (may extract)</button>
      {:else}
        <AsyncSlot
          value={s.slot}
          loadingText="extracting / loading options…"
          retry={() => app.retryConfig(s.id)}
        >
          {#snippet children()}{/snippet}
        </AsyncSlot>
      {/if}
    </div>
  {/if}
{/each}

{#if sideA && sideB}
  <p class="summary">
    {counts["only-a"]} only in A · {counts["only-b"]} only in B · {counts.differs} differ ·
    {counts.equal} same{counts.incomparable ? ` · ${counts.incomparable} not comparable` : ""}
    <label class="toggle">
      <input
        type="checkbox"
        checked={app.showAll}
        onchange={(e) => app.setFilters({ all: e.currentTarget.checked })}
      />
      show identical
    </label>
  </p>

  {#if visible.length === 0}
    <p class="muted">
      {app.q ? `No differing options match "${app.q}".` : "These configurations set the same options to the same values."}
    </p>
  {:else}
    <table>
      <thead>
        <tr>
          <th>option</th>
          <th>{a}</th>
          <th>{b}</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each shown as r (r.loc)}
          <tr class={r.kind}>
            <td>
              <button
                class="link mono"
                onclick={() => app.select({ kind: "option", configId: r.a ? a : b, loc: r.loc.split(".") })}
              >{r.loc}</button>
            </td>
            <td class="val mono" class:absent={!r.a?.customized}>{cellText(r.a)}</td>
            <td class="val mono" class:absent={!r.b?.customized}>{cellText(r.b)}</td>
            <td class="kind">{KIND_LABEL[r.kind]}</td>
          </tr>
        {/each}
      </tbody>
    </table>
    {#if visible.length > CAP}
      <p class="muted">
        Showing {CAP} of {visible.length} rows — refine the filter to narrow it down.
      </p>
    {/if}
  {/if}
{/if}

<style>
  h2 {
    margin: 0;
    font-size: 0.9375rem;
    word-break: break-all;
  }
  .crumb {
    margin: 2px 0 10px;
    font-size: 0.75rem;
    color: var(--ink-muted);
  }
  .mono {
    font-family: ui-monospace, monospace;
  }
  .muted {
    color: var(--ink-muted);
    font-size: 0.8125rem;
  }
  .load {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 0.8125rem;
    margin: 4px 0;
  }
  .summary {
    font-size: 0.8125rem;
    color: var(--ink-2);
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    border-top: 1px solid var(--grid);
    padding-top: 10px;
    margin-top: 10px;
  }
  .toggle {
    margin-left: auto;
    font-size: 0.75rem;
    color: var(--ink-2);
    display: inline-flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.75rem;
    margin-top: 8px;
  }
  th {
    text-align: left;
    font-weight: 600;
    color: var(--ink-muted);
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 4px 8px 4px 0;
    border-bottom: 1px solid var(--grid);
  }
  td {
    padding: 3px 8px 3px 0;
    border-bottom: 1px solid var(--grid);
    vertical-align: top;
  }
  .val {
    max-width: 22ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .val.absent {
    color: var(--ink-muted);
  }
  .kind {
    color: var(--ink-muted);
    white-space: nowrap;
  }
  tr.differs .kind {
    color: var(--warn);
  }
  .link {
    background: none;
    border: none;
    padding: 0;
    color: var(--link);
    font-size: 0.75rem;
    cursor: pointer;
    text-align: left;
    word-break: break-all;
  }
  .link:hover {
    text-decoration: underline;
  }
</style>
