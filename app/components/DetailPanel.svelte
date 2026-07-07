<script lang="ts">
  import { app } from "../lib/state.svelte";
  import { colorFor } from "../lib/color";
  import { THEMES } from "../lib/themes";
  import InputProvenance from "./InputProvenance.svelte";
  import OptionRow from "./OptionRow.svelte";

  interface Props {
    configId: string;
    moduleId: string;
  }
  const { configId, moduleId }: Props = $props();

  const gen = $derived(THEMES[app.themeIndex]!.gen);
  const cfg = $derived(app.activeConfig);
  const meta = $derived(cfg?.indexes.filesById.get(moduleId) ?? null);
  const refs = $derived(cfg?.indexes.refsByFile.get(moduleId) ?? null);

  const inputInfo = $derived(
    meta?.origin.kind === "input" ? (app.manifest?.inputs[meta.origin.input] ?? null) : null,
  );

  const colorKey = $derived(meta?.origin.kind === "input" ? meta.origin.input : moduleId);

  /** Configures: customized definitions from this file (defines is customized-only). */
  const configures = $derived.by(() => {
    if (!cfg || !refs) return [];
    return refs.defines.map((i) => cfg.data.options[i]!).sort(byLoc);
  });

  /** Declares: options this file declares; filter toggle hides untouched ones. */
  const declares = $derived.by(() => {
    if (!cfg || !refs) return [];
    const all = refs.declares.map((i) => cfg.data.options[i]!);
    return (app.showAll ? all : all.filter((o) => o.customized)).sort(byLoc);
  });

  const declaresTotal = $derived(refs?.declares.length ?? 0);
  const byLoc = (a: { loc: string[] }, b: { loc: string[] }) => a.loc.join(".").localeCompare(b.loc.join("."));

  const fileEntry = $derived(app.manifest?.files.find((f) => f.id === moduleId) ?? null);
</script>

{#if !cfg}
  <p class="muted">Loading configuration…</p>
{:else if !meta}
  <p class="muted">No data for this module in {configId}.</p>
{:else}
  <div class="head" style="--c:{colorFor(colorKey, gen)}">
    <span class="dot"></span>
    <h2 class="mono">{meta.relPath}</h2>
    <button class="filechip mono" onclick={() => app.select({ kind: "file", fileId: moduleId })}>
      file ↗
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
    margin-bottom: 6px;
  }
  .dot {
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: var(--c);
    flex: none;
  }
  h2 {
    margin: 0;
    font-size: 15px;
    word-break: break-all;
  }
  .mono {
    font-family: ui-monospace, monospace;
  }
  .filechip {
    margin-left: auto;
    background: var(--surface-1);
    border: 1px solid var(--grid);
    border-radius: 6px;
    color: var(--link);
    font-size: 12px;
    padding: 2px 8px;
    cursor: pointer;
    flex: none;
  }
  .git {
    color: var(--ink-muted);
    font-size: 12px;
    margin: 0 0 8px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  section {
    background: var(--surface-1);
    border: 1px solid var(--grid);
    border-radius: 10px;
    padding: 10px 14px;
    margin-top: 12px;
  }
  h3 {
    margin: 0 0 6px;
    font-size: 13px;
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
    font-size: 12px;
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
    font-size: 13px;
  }
</style>
