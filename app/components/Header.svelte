<script lang="ts">
  import { app } from "../lib/state.svelte";
  import { applyThemeVars } from "../lib/themes";

  const isDark = $derived(app.themeIndex === 1);
  function toggleTheme() {
    app.themeIndex = isDark ? 0 : 1;
    applyThemeVars(app.themeIndex);
  }
</script>

<header>
  <h1><button class="home" onclick={() => app.select(null)}>flake-explorer</button></h1>
  {#if app.manifest}
    <span class="ref" title={app.manifest.flake.path}>{app.manifest.flake.ref}</span>
    {#if app.manifest.flake.description}<span class="desc">{app.manifest.flake.description}</span>{/if}
  {/if}
  <span class="spacer"></span>
  <input
    type="search"
    name="filter"
    aria-label="Filter modules and files"
    placeholder="filter modules & files…"
    value={app.q}
    oninput={(e) => app.setFilters({ q: e.currentTarget.value })}
  />
  <button
    class="theme"
    type="button"
    aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
    title={isDark ? "Switch to light theme" : "Switch to dark theme"}
    onclick={toggleTheme}
  >{isDark ? "☀" : "☾"}</button>
</header>

<style>
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 14px;
    background: var(--surface-1);
    border-bottom: 1px solid var(--grid);
  }
  h1 {
    font-size: 15px;
    margin: 0;
  }
  .home {
    background: none;
    border: none;
    color: var(--ink-1);
    font: inherit;
    font-weight: 700;
    cursor: pointer;
    padding: 0;
  }
  .ref {
    font-family: ui-monospace, monospace;
    font-size: 12px;
    color: var(--link);
  }
  .desc {
    font-size: 12px;
    color: var(--ink-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 32ch;
  }
  .spacer {
    flex: 1;
  }
  input {
    background: var(--page);
    border: 1px solid var(--grid);
    border-radius: 6px;
    color: var(--ink-1);
    padding: 5px 10px;
    font-size: 13px;
    width: 220px;
  }
  input:focus {
    outline: none;
    border-color: var(--link);
  }
  .theme {
    width: 30px;
    height: 30px;
    border: 1px solid var(--grid);
    border-radius: 50%;
    background: var(--surface-1);
    color: var(--ink-2);
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
  }
  .theme:hover {
    color: var(--ink-1);
    border-color: var(--ink-muted);
  }
</style>
