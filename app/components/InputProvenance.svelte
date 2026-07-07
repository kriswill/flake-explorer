<script lang="ts">
  import Dot from "./Dot.svelte";
  import type { InputInfo } from "../../src/schema";
  import { app } from "../lib/state.svelte";
  import { colorFor } from "../lib/color";
  import { THEMES } from "../lib/themes";

  const { input }: { input: InputInfo } = $props();
  const gen = $derived(THEMES[app.themeIndex]!.gen);
  const date = $derived(
    input.lastModified ? new Date(input.lastModified * 1000).toISOString().slice(0, 10) : null,
  );
</script>

<div class="prov" style="--c:{colorFor(input.name, gen)}">
  <Dot />
  <b>input {input.name}</b>
  <span class="mono type">{input.type}{input.ref ? `:${input.ref}` : ""}</span>
  <dl>
    {#if input.url}<dt>url</dt><dd class="mono">{input.url}</dd>{/if}
    {#if input.rev}<dt>rev</dt><dd class="mono">{input.rev}</dd>{/if}
    {#if input.narHash}<dt>narHash</dt><dd class="mono">{input.narHash}</dd>{/if}
    {#if date}<dt>locked</dt><dd>{date}</dd>{/if}
    {#if input.follows}<dt>follows</dt><dd class="mono">{input.follows}</dd>{/if}
  </dl>
</div>

<style>
  .prov {
    background: color-mix(in srgb, var(--c) 8%, var(--surface-1));
    border: 1px solid color-mix(in srgb, var(--c) 35%, var(--grid));
    border-radius: 10px;
    padding: 8px 12px;
    font-size: 0.75rem;
    margin-bottom: 8px;
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
  }
  .type {
    color: var(--ink-muted);
  }
  .mono {
    font-family: ui-monospace, monospace;
  }
  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 10px;
    margin: 4px 0 0;
    width: 100%;
  }
  dt {
    color: var(--ink-muted);
  }
  dd {
    margin: 0;
    word-break: break-all;
  }
</style>
