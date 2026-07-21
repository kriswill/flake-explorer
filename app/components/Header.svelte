<script lang="ts">
import { prefs } from "../lib/prefs.svelte"
import { app } from "../lib/state.svelte"
import { TEXT_DEFAULT_STEP, TEXT_STEPS } from "../lib/type-scale"
import SearchBox from "./SearchBox.svelte"

const isDark = $derived(prefs.themeIndex === 1)
const toggleTheme = () => prefs.setTheme(isDark ? 0 : 1)

// One press = one step on the type scale, so the ends of the range are real
// stops rather than a click that silently does nothing. The middle button
// resets, and is itself inert while already at the default.
const atSmallest = $derived(prefs.textStep === 0)
const atLargest = $derived(prefs.textStep === TEXT_STEPS.length - 1)
const atDefault = $derived(prefs.textStep === TEXT_DEFAULT_STEP)
</script>

<!-- The word-processor "text size" glyph: a large T beside a small t, with
     the arrow saying which way this button moves. The reset button carries
     the pair alone. Drawn as paths rather than letters so the shape is the
     same in every font, and filled with currentColor so it picks up the
     button's own hover/disabled state. -->
{#snippet sizeIcon(dir: "up" | "down" | null)}
  <svg class="tt" viewBox={dir ? "0 0 24 16" : "0 0 17.5 16"} aria-hidden="true" focusable="false">
    <path d="M0.5 2h9v2H6v9H4V4H0.5z" />
    <path d="M10.5 7h6.5v1.7h-2.4v4.8h-1.7V8.7h-2.4z" />
    {#if dir === "up"}
      <path d="M21 3.5l3 4h-2v6h-2v-6h-2z" />
    {:else if dir === "down"}
      <path d="M21 13.5l-3-4h2v-6h2v6h2z" />
    {/if}
  </svg>
{/snippet}

<header>
  <h1>
    <button class="home" onclick={() => app.select(null)}>
      <span class="b1">Flake</span><span class="b2">Explorer</span>
    </button>
  </h1>
  <SearchBox />
  <div class="controls">
    <span class="fontctl" role="group" aria-label="Text size">
      <button
        type="button"
        title="Smaller text"
        aria-label="Smaller text (currently {prefs.textSizeName})"
        disabled={atSmallest}
        onclick={() => prefs.adjustTextStep(-1)}
      >{@render sizeIcon("down")}</button>
      <button
        type="button"
        class="reset"
        title="Reset text size"
        aria-label="Reset text size to default (currently {prefs.textSizeName})"
        disabled={atDefault}
        onclick={() => prefs.resetTextSize()}
      >{@render sizeIcon(null)}</button>
      <button
        type="button"
        title="Larger text"
        aria-label="Larger text (currently {prefs.textSizeName})"
        disabled={atLargest}
        onclick={() => prefs.adjustTextStep(1)}
      >{@render sizeIcon("up")}</button>
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
  </div>
</header>

<style>
  header {
    position: relative;
    z-index: 10;
    display: grid;
    grid-template-columns: 1fr minmax(280px, 480px) 1fr;
    align-items: center;
    gap: 12px;
    padding: 8px 14px;
    background: var(--surface-1);
    border-bottom: 1px solid color-mix(in srgb, var(--ink-1) 15%, var(--grid));
  }
  h1 {
    font-size: var(--text-sm);
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
  .controls {
    display: flex;
    align-items: center;
    gap: 12px;
    justify-self: end;
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
    display: inline-flex;
    align-items: center;
    padding: 5px 7px;
    cursor: pointer;
    line-height: 1;
  }
  /* Height in em so the glyph tracks the surrounding type; width follows the
     viewBox, which is narrower on the arrowless reset icon so the two T's
     stay the same size rather than being stretched to fill the arrow's slot. */
  .tt {
    height: 0.85em;
    width: auto;
    fill: currentColor;
  }
  .fontctl button + button {
    border-left: 1px solid var(--grid);
  }
  .fontctl button:hover:not(:disabled) {
    color: var(--ink-1);
    background: var(--page);
  }
  .fontctl button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  /* At the default there is nothing to reset, so the middle button reads as a
     quiet label rather than an action — full opacity would promise a click
     that does nothing. */
  .fontctl .reset {
    color: var(--ink-muted);
  }
  .fontctl .reset:disabled {
    opacity: 0.55;
  }
  .round {
    width: 30px;
    height: 30px;
    border: 1px solid var(--grid);
    border-radius: 50%;
    background: var(--surface-1);
    color: var(--ink-2);
    cursor: pointer;
    font-size: var(--text-sm);
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
