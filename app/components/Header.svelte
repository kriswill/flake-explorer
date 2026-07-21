<script lang="ts">
import { prefs } from "../lib/prefs.svelte"
import { app } from "../lib/state.svelte"
import { TEXT_DEFAULT_STEP, TEXT_STEPS, textStepName } from "../lib/type-scale"
import SearchBox from "./SearchBox.svelte"

const isDark = $derived(prefs.themeIndex === 1)
const toggleTheme = () => prefs.setTheme(isDark ? 0 : 1)

// One press = one step on the type scale, so the ends of the range are real
// stops rather than a click that silently does nothing.
const atSmallest = $derived(prefs.textStep === 0)
const atLargest = $derived(prefs.textStep === TEXT_STEPS.length - 1)
</script>

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
        aria-label="Smaller text"
        disabled={atSmallest}
        onclick={() => prefs.adjustTextStep(-1)}
      >A−</button>
      <button
        type="button"
        class="step"
        title="Reset text size to {textStepName(TEXT_DEFAULT_STEP)}"
        aria-label="Text size {prefs.textSizeName} — reset to {textStepName(TEXT_DEFAULT_STEP)}"
        onclick={() => prefs.resetTextSize()}
      >{prefs.textSizeName}</button>
      <button
        type="button"
        title="Larger text"
        aria-label="Larger text"
        disabled={atLargest}
        onclick={() => prefs.adjustTextStep(1)}
      >A+</button>
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
    font-size: 0.75rem;
    padding: 4px 8px;
    cursor: pointer;
    line-height: 1;
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
  .fontctl .step {
    min-width: 4ch;
    color: var(--ink-muted);
    text-align: center;
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
