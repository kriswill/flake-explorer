<script lang="ts">
import { colorFor } from "../lib/color"
import { prefs } from "../lib/prefs.svelte"
import { app } from "../lib/state.svelte"
import { THEMES } from "../lib/themes"
import Dot from "./Dot.svelte"
import InputProvenance from "./InputProvenance.svelte"
import OptionRow from "./OptionRow.svelte"

interface Props {
  configId: string
  moduleId: string
}
const { configId, moduleId }: Props = $props()

const gen = $derived(THEMES[prefs.themeIndex]!.gen)
const cfg = $derived(app.activeConfig)
const meta = $derived(cfg?.indexes.filesById.get(moduleId) ?? null)
const refs = $derived(cfg?.indexes.refsByFile.get(moduleId) ?? null)

const inputInfo = $derived(
  meta?.origin.kind === "input" ? (app.manifest?.inputs[meta.origin.input] ?? null) : null,
)

const colorKey = $derived(meta?.origin.kind === "input" ? meta.origin.input : moduleId)

/** Configures: customized definitions from this file (defines is customized-only). */
const configures = $derived.by(() => {
  if (!cfg || !refs) return []
  return refs.defines.map((i) => cfg.data.options[i]!).sort(byLoc)
})

/** Declares: options this file declares; filter toggle hides untouched ones. */
const declares = $derived.by(() => {
  if (!cfg || !refs) return []
  const all = refs.declares.map((i) => cfg.data.options[i]!)
  return (app.showAll ? all : all.filter((o) => o.customized)).sort(byLoc)
})

const declaresTotal = $derived(refs?.declares.length ?? 0)
const byLoc = (a: { loc: string[] }, b: { loc: string[] }) =>
  a.loc.join(".").localeCompare(b.loc.join("."))

const fileEntry = $derived(app.manifest?.files.find((f) => f.id === moduleId) ?? null)
</script>

{#if !cfg}
  <p class="muted">Loading configuration…</p>
{:else if !meta}
  <p class="muted">No data for this module in {configId}.</p>
{:else}
  <div class="head" style="--c:{colorFor(colorKey, gen)}">
    <Dot />
    <h2 class="mono">{meta.relPath}</h2>
    <button class="filechip mono" onclick={() => app.select({ kind: "file", fileId: moduleId })}>
      <!-- nixos snowflake mark (brand.nixos.org): a .nix file is raw Nix source -->
      <svg viewBox="-1152 -998 2304 1996" width="16" height="13.9" aria-hidden="true" focusable="false">
        <g fill="currentColor">
          <polygon points="-624,249.42 -496,27.71 64,997.66 -192,997.66 -320,775.96 -448,997.66 -576,997.66 -640,886.81 -448,554.26" />
          <polygon points="-528,-415.69 -272,-415.69 -832,554.26 -960,332.55 -832,110.85 -1088,110.85 -1152,0 -1088,-110.85 -704,-110.85" />
          <polygon points="96,-665.11 224,-443.41 -896,-443.41 -768,-665.11 -512,-665.11 -640,-886.81 -576,-997.66 -448,-997.66 -256,-665.11" />
          <polygon points="624,-249.42 496,-27.71 -64,-997.66 192,-997.66 320,-775.96 448,-997.66 576,-997.66 640,-886.81 448,-554.26" />
          <polygon points="528,415.69 272,415.69 832,-554.26 960,-332.55 832,-110.85 1088,-110.85 1152,0 1088,110.85 704,110.85" />
          <polygon points="-96,665.11 -224,443.41 896,443.41 768,665.11 512,665.11 640,886.81 576,997.66 448,997.66 256,665.11" />
        </g>
      </svg>
      file
      <!-- diagonal arrow -->
      <svg class="arrow" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" focusable="false">
        <path d="M6 10 10 6M8 6h2v2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
  </div>
  {#if meta.origin.kind === "input" && inputInfo}
    <InputProvenance input={inputInfo} />
  {:else if fileEntry?.git}
    <p class="git mono" title={fileEntry.git.subject}>
      last commit {fileEntry.git.commit.slice(0, 10)} · {fileEntry.git.date.slice(0, 10)} · {fileEntry.git.subject}
    </p>
  {/if}

  <section>
    <h3>Configures <span class="count">{configures.length}</span></h3>
    {#if configures.length === 0}
      <p class="muted">This file customizes no option values in {configId}.</p>
    {:else}
      <ul class="opts">
        {#each configures as entry (entry.loc.join("."))}
          <OptionRow {entry} highlightFile={meta.storePath} />
        {/each}
      </ul>
    {/if}
  </section>

  <section>
    <h3>
      Declares <span class="count">{declaresTotal}</span>
      {#if declaresTotal > 0}
        <label class="toggle">
          <input type="checkbox" checked={app.showAll} onchange={(e) => app.setFilters({ all: e.currentTarget.checked })} />
          show untouched ({declaresTotal - declares.filter((o) => o.customized).length})
        </label>
      {/if}
    </h3>
    {#if declaresTotal === 0}
      <p class="muted">This file declares no options — it only sets existing ones.</p>
    {:else if declares.length === 0}
      <p class="muted">None of the {declaresTotal} declared options are customized.</p>
    {:else}
      <ul class="opts">
        {#each declares as entry (entry.loc.join("."))}
          <OptionRow {entry} highlightFile={meta.storePath} />
        {/each}
      </ul>
    {/if}
  </section>
{/if}

<style>
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  h2 {
    margin: 0;
    font-size: 0.9375rem;
    word-break: break-all;
  }
  .mono {
    font-family: ui-monospace, monospace;
  }
  .filechip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
    background: var(--surface-1);
    border: 1px solid var(--grid);
    border-radius: 7px;
    color: var(--ink-2);
    font-size: 0.75rem;
    font-weight: 500;
    padding: 4px 10px;
    cursor: pointer;
    flex: none;
    transition:
      background-color 0.15s ease,
      border-color 0.15s ease,
      color 0.15s ease;
  }
  .filechip:hover {
    background: var(--page);
    border-color: var(--c);
    color: var(--c);
  }
  .filechip:active {
    transform: translateY(1px);
  }
  .filechip svg {
    flex: none;
  }
  .filechip .arrow {
    opacity: 0.6;
  }
  .filechip:hover .arrow {
    opacity: 1;
  }
  .git {
    color: var(--ink-muted);
    font-size: 0.75rem;
    margin: 0 0 8px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  section {
    border-top: 1px solid var(--grid);
    padding-top: 10px;
    margin-top: 12px;
  }
  h3 {
    margin: 0 0 6px;
    font-size: 0.8125rem;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .count {
    color: var(--ink-muted);
    font-weight: normal;
  }
  .toggle {
    margin-left: auto;
    font-size: 0.75rem;
    font-weight: normal;
    color: var(--ink-2);
    display: inline-flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
  }
  .opts {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .muted {
    color: var(--ink-muted);
    font-size: 0.8125rem;
  }
</style>
