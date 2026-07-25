<!-- Shared breadcrumb strip across detail panes: segments with a selection
     render as links, plain segments (dirs, the current page) as text. -->
<script lang="ts">
import type { Crumb } from "../lib/indexes"
import { app } from "../lib/state.svelte"

const { segments }: { segments: Crumb[] } = $props()
</script>

<nav class="crumbs" aria-label="breadcrumb">
  {#each segments as s, i (i)}
    {#if i > 0}<span class="sep">›</span>{/if}
    {#if s.sel}
      {@const sel = s.sel}
      <button class="link mono" onclick={() => app.select(sel)}>{s.label}</button>
    {:else}
      <span class="mono">{s.label}</span>
    {/if}
  {/each}
</nav>

<style>
  .crumbs {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 4px;
    margin: 0 0 6px;
    font-size: var(--text-2xs);
    color: var(--ink-muted);
  }
  .mono {
    font-family: ui-monospace, monospace;
  }
  .sep {
    user-select: none;
  }
  .link {
    background: none;
    border: none;
    padding: 0;
    font-size: var(--text-2xs);
    color: var(--link);
    cursor: pointer;
    word-break: break-all;
  }
  .link:hover {
    text-decoration: underline;
  }
</style>
