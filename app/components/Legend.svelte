<script lang="ts">
import { colorFor } from "../lib/color"
import { app } from "../lib/state.svelte"
import { THEMES } from "../lib/themes"
import { webUrl } from "../lib/url"
import Dot from "./Dot.svelte"

const gen = $derived(THEMES[app.themeIndex]!.gen)
const inputs = $derived(Object.values(app.manifest?.inputs ?? {}).filter((i) => !i.transitive))
</script>

<div class="legend">
  {#each inputs as input (input.name)}
    {@const link = webUrl(input.url)}
    {#if link}
      <a class="chip" style="--c:{colorFor(input.name, gen)}" href={link} target="_blank" rel="noopener" title={input.url}>
        <Dot />{input.name}
      </a>
    {:else}
      <span class="chip" style="--c:{colorFor(input.name, gen)}" title={input.url ?? input.type}>
        <Dot />{input.name}
      </span>
    {/if}
  {/each}
</div>

<style>
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 10px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 0.75rem;
    color: var(--ink-2);
    border: 1px solid var(--grid);
    border-radius: 10px;
    padding: 2px 8px;
    text-decoration: none;
  }
  a.chip {
    cursor: pointer;
    transition:
      color 0.15s ease,
      border-color 0.15s ease;
  }
  a.chip:hover {
    color: var(--c);
    border-color: var(--c);
  }
</style>
