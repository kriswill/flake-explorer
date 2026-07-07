<script lang="ts">
  import { app } from "../lib/state.svelte";
  import { colorFor } from "../lib/color";
  import { THEMES } from "../lib/themes";
  import InputProvenance from "./InputProvenance.svelte";

  const { fileId }: { fileId: string } = $props();

  const gen = $derived(THEMES[app.themeIndex]!.gen);
  const manifestEntry = $derived(app.manifest?.files.find((f) => f.id === fileId) ?? null);

  /** Config-side view of this file (any loaded config that references it). */
  const configView = $derived.by(() => {
    for (const [configId, slot] of Object.entries(app.configs)) {
      if (typeof slot !== "object" || !("indexes" in slot)) continue;
      const meta = slot.indexes.filesById.get(fileId);
      if (meta) return { configId, slot, meta, refs: slot.indexes.refsByFile.get(fileId)! };
    }
    return null;
  });

  const relPath = $derived(manifestEntry?.relPath ?? configView?.meta.relPath ?? fileId);
  const inputName = $derived.by(() => {
    const origin = manifestEntry?.origin ?? configView?.meta.origin;
    return origin?.kind === "input" ? origin.input : null;
  });
  const inputInfo = $derived(inputName ? (app.manifest?.inputs[inputName] ?? null) : null);
  const colorKey = $derived(inputName ?? fileId);

  const imports = $derived([...(app.flakeIndexes?.imports.get(fileId) ?? [])]);
  const importedBy = $derived([...(app.flakeIndexes?.importedBy.get(fileId) ?? [])]);

  /** Options this file customizes, grouped per loaded config. */
  const customizes = $derived.by(() => {
    if (!configView) return [];
    return configView.refs.defines.map((i) => configView.slot.data.options[i]!);
  });

  let copied = $state(false);
  async function copyHash() {
    if (!manifestEntry?.git) return;
    await navigator.clipboard.writeText(manifestEntry.git.commit);
    copied = true;
    setTimeout(() => (copied = false), 1200);
  }

  const label = (id: string) => id.replace(/^self:/, "").replace(/^input:[^:]+:/, "");
</script>

<div class="head" style="--c:{colorFor(colorKey, gen)}">
  <span class="dot"></span>
  <h2 class="mono">{relPath}</h2>
</div>

{#if inputInfo}
  <InputProvenance input={inputInfo} />
{/if}

{#if manifestEntry?.git}
  <div class="card">
    <h3>last commit</h3>
    <p class="mono commit">
      {manifestEntry.git.commit}
      <button class="copy" onclick={copyHash}>{copied ? "copied" : "copy"}</button>
    </p>
    <p class="muted">{manifestEntry.git.date.slice(0, 19).replace("T", " ")} — {manifestEntry.git.subject}</p>
  </div>
{:else if inputInfo?.rev}
  <div class="card">
    <h3>locked revision</h3>
    <p class="mono commit">{inputInfo.rev}</p>
  </div>
{/if}

{#if imports.length || importedBy.length}
  <div class="card">
    {#if importedBy.length}
      <h3>imported by <span class="count">{importedBy.length}</span></h3>
      <ul>
        {#each importedBy as id (id)}
          <li><button class="link mono" onclick={() => app.select({ kind: "file", fileId: id })}>{label(id)}</button></li>
        {/each}
      </ul>
    {/if}
    {#if imports.length}
      <h3>imports <span class="count">{imports.length}</span></h3>
      <ul>
        {#each imports as id (id)}
          <li><button class="link mono" onclick={() => app.select({ kind: "file", fileId: id })}>{label(id)}</button></li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}

{#if configView}
  <div class="card">
    <h3>customizes in {configView.configId} <span class="count">{customizes.length}</span></h3>
    {#if customizes.length === 0}
      <p class="muted">No customized option values from this file.</p>
    {:else}
      <ul>
        {#each customizes.slice(0, 50) as o (o.loc.join("."))}
          <li>
            <button
              class="link mono"
              onclick={() => app.select({ kind: "module", configId: configView.configId, moduleId: fileId })}
            >{o.loc.join(".")}</button>
          </li>
        {/each}
        {#if customizes.length > 50}<li class="muted">… and {customizes.length - 50} more</li>{/if}
      </ul>
    {/if}
  </div>
{:else}
  <p class="muted">Load a configuration on the left to see which options this file affects.</p>
{/if}

<style>
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
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
    font-size: 0.9375rem;
    word-break: break-all;
  }
  .card {
    background: var(--surface-1);
    border: 1px solid var(--grid);
    border-radius: 10px;
    padding: 10px 14px;
    margin-top: 10px;
  }
  h3 {
    margin: 6px 0;
    font-size: 0.8125rem;
  }
  .count {
    color: var(--ink-muted);
    font-weight: normal;
  }
  .mono {
    font-family: ui-monospace, monospace;
  }
  .commit {
    font-size: 0.8125rem;
    word-break: break-all;
    margin: 2px 0;
  }
  .copy {
    background: var(--page);
    border: 1px solid var(--grid);
    border-radius: 4px;
    color: var(--ink-2);
    font-size: 0.6875rem;
    cursor: pointer;
    margin-left: 6px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    font-size: 0.75rem;
  }
  .link {
    background: none;
    border: none;
    color: var(--link);
    cursor: pointer;
    font-size: 0.75rem;
    padding: 1px 0;
    text-align: left;
    word-break: break-all;
  }
  .muted {
    color: var(--ink-muted);
    font-size: 0.75rem;
  }
  p {
    margin: 3px 0;
    font-size: 0.8125rem;
  }
</style>
