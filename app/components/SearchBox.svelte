<script lang="ts">
import { isStatic } from "../lib/data"
import { flatHits, type OptionSource, searchAll } from "../lib/search"
import { app, loadedConfig } from "../lib/state.svelte"
import AsyncSlot from "./AsyncSlot.svelte"

let open = $state(false)
let active = $state(0)
let wrap: HTMLElement | undefined = $state()

/** Static export: every config blob is already embedded — load them all on
 * first search focus so the corpus is complete for free. Never in dynamic
 * serve, where loading can mean minutes of on-demand extraction. */
let autoloaded = false
function onFocus() {
  if (isStatic() && !autoloaded) {
    autoloaded = true
    for (const c of app.manifest?.configurations ?? []) void app.loadConfig(c.id)
  }
  open = app.q.trim().length > 0
}

const sources = $derived.by(() => {
  const out: OptionSource[] = []
  for (const c of app.manifest?.configurations ?? []) {
    const loaded = loadedConfig(app.configs[c.id])
    if (loaded) {
      out.push({
        configId: c.id,
        options: loaded.data.options,
        locsLower: loaded.indexes.optionLocsLower,
      })
    }
  }
  return out
})

const categories = $derived(
  open && app.manifest && app.q.trim() ? searchAll(app.q, app.manifest, sources) : [],
)
const hits = $derived(flatHits(categories))

/** Configurations whose options are not in the corpus yet. */
const unloaded = $derived(
  (app.manifest?.configurations ?? []).filter((c) => !loadedConfig(app.configs[c.id])),
)

function input(e: Event & { currentTarget: HTMLInputElement }) {
  app.setFilters({ q: e.currentTarget.value })
  open = e.currentTarget.value.trim().length > 0
  active = 0
}

function pick(i: number) {
  const hit = hits[i]
  if (!hit) return
  app.select(hit.sel)
  open = false
}

function key(e: KeyboardEvent) {
  if (!open) return
  if (e.key === "ArrowDown") {
    e.preventDefault()
    active = hits.length ? (active + 1) % hits.length : 0
  } else if (e.key === "ArrowUp") {
    e.preventDefault()
    active = hits.length ? (active - 1 + hits.length) % hits.length : 0
  } else if (e.key === "Enter") {
    if (hits.length) {
      e.preventDefault()
      pick(active)
    }
  } else if (e.key === "Escape") {
    open = false
  }
}

/** Close only when focus leaves the whole widget (results clicks keep it). */
function focusout(e: FocusEvent) {
  if (!wrap?.contains(e.relatedTarget as Node | null)) open = false
}

const SECTION_LABELS = {
  options: "Options",
  packages: "Packages",
  files: "Files",
  inputs: "Inputs",
} as const

/** Index of a category's first hit within the flat list. */
function baseIndex(catIndex: number): number {
  let n = 0
  for (let i = 0; i < catIndex; i++) n += categories[i]!.hits.length
  return n
}
</script>

<div class="wrap" bind:this={wrap} onfocusout={focusout}>
  <input
    class="search"
    type="search"
    name="filter"
    aria-label="Filter modules and files; search options, packages, and inputs"
    placeholder="search options, packages & files…"
    autocomplete="off"
    value={app.q}
    oninput={input}
    onfocus={onFocus}
    onkeydown={key}
  />
  {#if open && app.q.trim()}
    <div class="results" role="listbox" aria-label="Search results">
      {#if hits.length === 0}
        <p class="empty muted">
          No matches{sources.length === 0 ? " — no configuration loaded yet, so options are not searchable" : ""}.
        </p>
      {/if}
      {#each categories as cat, ci (cat.kind)}
        <div class="cathead">{SECTION_LABELS[cat.kind]}</div>
        {#each cat.hits as hit, hi (`${hit.sel.kind}:${hit.label}:${hit.detail ?? ""}`)}
          {@const idx = baseIndex(ci) + hi}
          <button
            class="hit"
            class:active={idx === active}
            role="option"
            aria-selected={idx === active}
            onpointerenter={() => (active = idx)}
            onclick={() => pick(idx)}
          >
            <span class="label mono" class:customized={hit.customized}>{hit.label}</span>
            {#if hit.detail}<span class="detail">{hit.detail}</span>{/if}
          </button>
        {/each}
        {#if cat.total > cat.hits.length}
          <p class="more muted">… and {cat.total - cat.hits.length} more</p>
        {/if}
      {/each}
      {#if unloaded.length}
        <div class="foot">
          {#each unloaded as c (c.id)}
            {#if !app.configs[c.id]}
              <button class="loadlink" onclick={() => void app.loadConfig(c.id)}>
                search options in {c.id} (loads on demand)
              </button>
            {:else}
              <!-- Only ever loading/errored here: a loaded slot leaves `unloaded`. -->
              <div class="slotrow">
                <span class="muted mono">{c.id}</span>
                <AsyncSlot
                  value={app.configs[c.id]}
                  loadingText="loading options…"
                  retry={() => app.retryConfig(c.id)}
                >
                  {#snippet children()}{/snippet}
                </AsyncSlot>
              </div>
            {/if}
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .wrap {
    position: relative;
    width: 100%;
  }
  /* The query text scales with the text-size control — it is content you
     have to read back. The BOX does not: a fixed height keeps it from
     pushing the top bar taller as the type grows. 30px clears the largest
     step (~20px text) without clipping, so the text needs no cap.
     Horizontal-only padding, since the height now does the centring. */
  .search {
    background: var(--page);
    border: 1px solid var(--grid);
    border-radius: 6px;
    color: var(--ink-1);
    height: 30px;
    padding: 0 10px;
    font-size: var(--text-xs);
    width: 100%;
    box-sizing: border-box;
  }
  .search:focus {
    outline: none;
    border-color: var(--link);
  }
  .results {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    max-height: 60vh;
    overflow-y: auto;
    background: var(--surface-1);
    border: 1px solid var(--grid);
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
    padding: 4px;
    z-index: 20;
  }
  .cathead {
    font-size: var(--text-3xs);
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink-muted);
    padding: 6px 8px 2px;
  }
  .hit {
    display: flex;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    background: none;
    border: none;
    border-radius: 6px;
    padding: 4px 8px;
    font: inherit;
    font-size: var(--text-xs);
    color: var(--ink-1);
    cursor: pointer;
    text-align: left;
  }
  .hit.active {
    background: var(--page);
  }
  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: none;
    max-width: 60%;
  }
  .label.customized {
    font-weight: 600;
  }
  .detail {
    color: var(--ink-muted);
    font-size: var(--text-2xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mono {
    font-family: ui-monospace, monospace;
  }
  .empty,
  .more {
    margin: 2px 0;
    padding: 2px 8px;
  }
  .muted {
    color: var(--ink-muted);
    font-size: var(--text-2xs);
  }
  .foot {
    border-top: 1px solid var(--grid);
    margin-top: 4px;
    padding: 6px 8px 2px;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .slotrow {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }
  .slotrow :global(.slot-note) {
    margin: 0;
  }
  .loadlink {
    background: none;
    border: none;
    padding: 0;
    color: var(--link);
    font-size: var(--text-2xs);
    cursor: pointer;
    text-align: left;
  }
  .loadlink:hover {
    text-decoration: underline;
  }
</style>
