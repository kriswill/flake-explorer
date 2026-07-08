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
  <h1>
    <button class="home" onclick={() => app.select(null)}>
      <span class="b1">Flake</span><span class="b2">Explorer</span>
    </button>
  </h1>
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
  <span class="fontctl" role="group" aria-label="Text size">
    <button type="button" title="Smaller text" aria-label="Smaller text" onclick={() => app.adjustFontScale(-0.1)}>A−</button>
    <button
      type="button"
      class="pct"
      title="Reset text size"
      aria-label="Reset text size to 100%"
      onclick={() => app.setFontScale(1)}
    >{Math.round(app.fontScale * 100)}%</button>
    <button type="button" title="Larger text" aria-label="Larger text" onclick={() => app.adjustFontScale(0.1)}>A+</button>
  </span>
  <button
    class="round theme"
    type="button"
    aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
    title={isDark ? "Switch to light theme" : "Switch to dark theme"}
    onclick={toggleTheme}
  >{isDark ? "☀" : "☾"}</button>
  <button
    class="round help"
    type="button"
    aria-label="About Flake Explorer"
    title="About Flake Explorer"
    onclick={() => app.openAbout()}
  >?</button>
</header>

<style>
  header {
    position: relative;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 14px;
    background: var(--surface-1);
    border-bottom: 1px solid color-mix(in srgb, var(--ink-1) 15%, var(--grid));
  }
  h1 {
    font-size: 0.9375rem;
    margin: 0;
  }
  .home {
    background: none;
    border: none;
    font: inherit;
    font-weight: 700;
    cursor: pointer;
    padding: 0;
  }
  /* okflight-style two-tone wordmark: bold ink + regular muted, no gap. */
  .b1 {
    color: var(--ink-1);
    font-weight: 700;
  }
  .b2 {
    color: var(--ink-muted);
    font-weight: 400;
  }
  .ref {
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
    color: var(--link);
  }
  .desc {
    font-size: 0.75rem;
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
    font-size: 0.8125rem;
    width: 220px;
  }
  input:focus {
    outline: none;
    border-color: var(--link);
  }
  .fontctl {
    display: inline-flex;
    border: 1px solid var(--grid);
    border-radius: 6px;
    overflow: hidden;
  }
  .fontctl button {
    background: var(--surface-1);
    border: none;
    color: var(--ink-2);
    font-size: 0.75rem;
    padding: 4px 8px;
    cursor: pointer;
    line-height: 1;
  }
  .fontctl button + button {
    border-left: 1px solid var(--grid);
  }
  .fontctl button:hover {
    color: var(--ink-1);
    background: var(--page);
  }
  .fontctl .pct {
    min-width: 6ch;
    color: var(--ink-muted);
    font-variant-numeric: tabular-nums;
  }
  .round {
    width: 30px;
    height: 30px;
    border: 1px solid var(--grid);
    border-radius: 50%;
    background: var(--surface-1);
    color: var(--ink-2);
    cursor: pointer;
    font-size: 0.875rem;
    line-height: 1;
    flex: none;
  }
  .round:hover {
    color: var(--ink-1);
    border-color: var(--ink-muted);
  }
  .help {
    font-weight: 600;
  }
</style>
