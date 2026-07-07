<script lang="ts">
  import { app } from "../lib/state.svelte";
  import { colorFor } from "../lib/color";
  import { THEMES } from "../lib/themes";

  const gen = $derived(THEMES[app.themeIndex]!.gen);
  const inputs = $derived(Object.values(app.manifest?.inputs ?? {}).filter((i) => !i.transitive));
</script>

<div class="legend">
  {#each inputs as input (input.name)}
    <span class="chip" style="--c:{colorFor(input.name, gen)}" title={input.url ?? input.type}>
      <span class="dot"></span>{input.name}
    </span>
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
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--c);
  }
</style>
