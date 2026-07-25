<script lang="ts">
import { colorFor } from "../lib/color"
import { crumbsForFile } from "../lib/indexes"
import { prefs } from "../lib/prefs.svelte"
import { app } from "../lib/state.svelte"
import Breadcrumb from "./Breadcrumb.svelte"
import Dot from "./Dot.svelte"
import HeaderChip from "./HeaderChip.svelte"
import InputProvenance from "./InputProvenance.svelte"
import OptionRow from "./OptionRow.svelte"

interface Props {
  configId: string
  moduleId: string
}
const { configId, moduleId }: Props = $props()

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
  <Breadcrumb segments={crumbsForFile(meta, configId)} />
  <div class="head" style="--c:{colorFor(colorKey, prefs.gen)}">
    <Dot />
    <h2 class="mono">{meta.relPath}</h2>
    <HeaderChip label="file" onclick={() => app.select({ kind: "file", fileId: moduleId })}>
      {#snippet icon()}
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
      {/snippet}
    </HeaderChip>
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
          <OptionRow {entry} highlightFile={meta.storePath} {configId} />
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
          <OptionRow {entry} highlightFile={meta.storePath} {configId} />
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
    font-size: var(--text-sm);
    word-break: break-all;
  }
  .mono {
    font-family: ui-monospace, monospace;
  }
  .git {
    color: var(--ink-muted);
    font-size: var(--text-2xs);
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
    font-size: var(--text-xs);
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
    font-size: var(--text-2xs);
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
    font-size: var(--text-xs);
  }
</style>
