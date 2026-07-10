<script lang="ts">
  import { app } from "../lib/state.svelte";
  import { colorFor } from "../lib/color";
  import { THEMES } from "../lib/themes";
  import Dot from "./Dot.svelte";
  import InputProvenance from "./InputProvenance.svelte";
  import SourceView from "./SourceView.svelte";
  import { segmentLines } from "../lib/segments";
  import { makeFileId } from "../../src/schema";

  const { name }: { name: string } = $props();

  const gen = $derived(THEMES[app.themeIndex]!.gen);
  const input = $derived(app.manifest?.inputs[name] ?? null);

  /** The input's own flake.nix out of the store — same id scheme as option files. */
  const fileId = $derived(makeFileId({ kind: "input", input: name }, "flake.nix"));
  const contentSlot = $derived(app.fileContents[fileId]);

  $effect(() => {
    if (input?.storePath) app.loadFileContent(fileId, `${input.storePath}/flake.nix`);
  });

  const lines = $derived.by(() => {
    if (!contentSlot || typeof contentSlot !== "object" || !("text" in contentSlot)) return [];
    return segmentLines(contentSlot.text, contentSlot.tokens);
  });
</script>

<div class="input-detail">
  <div class="id-head">
    <div class="head" style="--c:{colorFor(name, gen)}">
      <Dot />
      <h2 class="mono">inputs.{name}</h2>
    </div>

    {#if !input}
      <p class="muted">No input named "{name}" in this flake.</p>
    {:else}
      <InputProvenance {input} />

      <div class="section">
        <h3>flake.nix <span class="path mono">{input.storePath ? `${input.storePath}/flake.nix` : ""}</span></h3>
      </div>
    {/if}
  </div>

  {#if input}
    <div class="id-body">
      {#if !input.storePath}
        <p class="muted">Source not available (input was not fetched during extraction).</p>
      {:else if !contentSlot || contentSlot === "loading"}
        <p class="muted">loading source…</p>
      {:else if "error" in contentSlot}
        <p class="muted err">
          {contentSlot.error.split("\n")[0]}
          <button class="retry" onclick={() => app.retryFileContent(fileId, `${input.storePath}/flake.nix`)}>retry</button>
        </p>
      {:else}
        <SourceView {lines} />
      {/if}
    </div>
  {/if}
</div>

<style>
  .input-detail {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .id-head {
    flex: none;
  }
  .id-body {
    flex: 1 1 0%;
    min-height: 0;
    overflow-y: auto;
  }
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
  .section {
    border-top: 1px solid var(--grid);
    padding-top: 10px;
    margin-top: 10px;
  }
  h3 {
    margin: 6px 0;
    font-size: 0.8125rem;
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .path {
    font-weight: 400;
    font-size: 0.6875rem;
    color: var(--ink-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mono {
    font-family: ui-monospace, monospace;
  }
  .muted {
    color: var(--ink-muted);
    font-size: 0.75rem;
  }
  .err {
    color: var(--err);
  }
  .retry {
    background: none;
    border: 1px solid var(--grid);
    border-radius: 4px;
    color: var(--ink-2);
    font-size: 0.6875rem;
    cursor: pointer;
    margin-left: 6px;
  }
</style>
