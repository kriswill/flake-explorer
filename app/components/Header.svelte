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

<!--
  The familiar "text size" glyph: a heavy A with a +/− tucked into its
  shoulder. Geometry, not a font, so it looks the same everywhere and stays
  crisp at any scale.

  The A is drawn as one outline plus its counter, knocked out with evenodd,
  and takes currentColor so it inherits the button's hover/disabled state.
  The sign is the accent color, and the A is masked by a disc around it —
  a real hole, so the notch reads against whatever is behind the button
  (surface, hover, modal) instead of being painted a background color that
  would be wrong the moment the surface changed.

  The mask id is per-direction: each variant appears once, so the ids stay
  unique in the document.
-->
{#snippet sizeIcon(dir: "up" | "down" | null)}
  <svg class="szicon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    {#if dir}
      <mask id="sz-notch-{dir}">
        <rect width="24" height="24" fill="#fff" />
        <circle cx="18.3" cy="5.2" r="6.4" fill="#000" />
      </mask>
    {/if}
    <path
      class="letter"
      fill-rule="evenodd"
      mask={dir ? `url(#sz-notch-${dir})` : undefined}
      d="M0 22.8 8.1 2.4h4.3l8.1 20.4h-5.6L13.3 18.4H7.2L5.6 22.8zM10.25 8.2 12.75 15.2h-5z"
    />
    {#if dir}
      <rect class="sign" x="13.8" y="3.9" width="9" height="2.6" rx="1.3" />
    {/if}
    {#if dir === "up"}
      <rect class="sign" x="17" y="0.7" width="2.6" height="9" rx="1.3" />
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
  /* Height in em so the glyph tracks the surrounding type. */
  .szicon {
    height: 1.15em;
    width: auto;
  }
  .letter {
    fill: currentColor;
  }
  .sign {
    fill: var(--link);
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
