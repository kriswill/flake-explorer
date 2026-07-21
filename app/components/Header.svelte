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
    <!--
      Theme switch: a track the knob slides along, carrying the sun out and
      the moon in. One inline SVG, animated entirely in CSS — no sprite, no
      icon font, crisp at any size, and it scales with the text control like
      the rest of the header.

      It is a switch, not a button that relabels itself: role/aria-checked
      state the theme it IS, which is also what the knob position shows.
    -->
    <button
      class="themesw"
      type="button"
      role="switch"
      aria-checked={isDark}
      aria-label="Dark theme"
      title={isDark ? "Switch to light theme" : "Switch to dark theme"}
      onclick={toggleTheme}
    >
      <svg class="tsw" class:dark={isDark} viewBox="0 0 44 24" aria-hidden="true" focusable="false">
        <!-- Crescent by subtraction: a disc with a second disc masked out,
             which stays a clean arc at any size where a drawn curve would
             need hinting. -->
        <mask id="tsw-crescent">
          <circle cx="12" cy="12" r="6.2" fill="#fff" />
          <circle cx="14.2" cy="9.8" r="5.8" fill="#000" />
        </mask>
        <rect class="track" x="1" y="1" width="42" height="22" rx="11" />
        <g class="knob">
          <circle class="cap" cx="12" cy="12" r="8.5" />
          <g class="sun">
            <circle class="core" cx="12" cy="12" r="3.2" />
            <g class="rays">
              <line x1="12" y1="7.3" x2="12" y2="5.6" />
              <line x1="15.32" y1="8.68" x2="16.53" y2="7.47" />
              <line x1="16.7" y1="12" x2="18.4" y2="12" />
              <line x1="15.32" y1="15.32" x2="16.53" y2="16.53" />
              <line x1="12" y1="16.7" x2="12" y2="18.4" />
              <line x1="8.68" y1="15.32" x2="7.47" y2="16.53" />
              <line x1="7.3" y1="12" x2="5.6" y2="12" />
              <line x1="8.68" y1="8.68" x2="7.47" y2="7.47" />
            </g>
          </g>
          <circle class="moon" cx="12" cy="12" r="6.2" mask="url(#tsw-crescent)" />
        </g>
      </svg>
    </button>
    <!--
      About: a solid speech bubble with the i knocked out of it.

      Solid-with-a-hole rather than a stroked ring and a drawn letter: at
      21px thin strokes silt up and the counter of the i closes, while one
      filled shape keeps its silhouette and the hole stays open. The hole is
      a real hole, so it shows the surface behind rather than being painted
      a background colour that would be wrong on hover or in the dark theme.
    -->
    <button
      class="about"
      type="button"
      aria-label="About Flake Explorer"
      title="About Flake Explorer"
      onclick={() => app.openAbout()}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <mask id="about-i">
          <rect width="24" height="24" fill="#fff" />
          <circle cx="13.1" cy="6.4" r="1.9" fill="#000" />
          <!-- A few degrees of lean: enough to read as a letter rather than
               a bar, not enough to blur its edges at this size. -->
          <rect
            x="10.8"
            y="9.2"
            width="3"
            height="8"
            rx="1.5"
            fill="#000"
            transform="rotate(8 12.3 13.2)"
          />
        </mask>
        <!-- Arc the long way round, then out to the tail point and back. -->
        <path class="bubble" mask="url(#about-i)" d="M20.19 17.34A10 10 0 1 0 15.42 21L20.13 22Z" />
      </svg>
    </button>
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
  /* ---- theme switch ---- */
  .themesw {
    background: none;
    border: none;
    padding: 0;
    display: inline-flex;
    flex: none;
    cursor: pointer;
    border-radius: 999px;
  }
  .themesw:focus-visible {
    outline: 2px solid var(--link);
    outline-offset: 2px;
  }
  .tsw {
    height: 1.55em;
    width: auto;
    display: block;
  }
  /* The track reads as recessed by being the page colour inside the header's
     lighter surface — true in both themes, so no per-theme override. */
  .track {
    fill: var(--page);
    stroke: var(--grid);
    stroke-width: 1.5;
  }
  /* Likewise the knob is the header's own surface, so it stays "raised"
     whichever theme is on. */
  .cap {
    fill: var(--surface-1);
    stroke: var(--grid);
    stroke-width: 1;
  }
  /* surface-1 over page is only a couple of shades in either theme, so the
     knob needs a shadow to read as sitting on top of the track rather than
     cut into it. */
  .knob {
    filter: drop-shadow(0 1px 1.2px rgb(0 0 0 / 0.4));
    transition: transform 0.4s cubic-bezier(0.34, 1.25, 0.5, 1);
  }
  .tsw.dark .knob {
    transform: translateX(20px);
  }
  /* Each face is only ever seen under its own theme — the sun against the
     light knob, the moon against the dark one — so a single theme variable
     each is enough. */
  .sun {
    fill: var(--s3);
    stroke: var(--s3);
  }
  .core {
    stroke: none;
  }
  .rays line {
    stroke-width: 1.6;
    stroke-linecap: round;
  }
  .moon {
    fill: var(--ink-2);
  }
  /* fill-box so the spin turns about the glyph itself rather than the SVG
     origin, which would swing it out of the knob. */
  .sun,
  .moon {
    transform-box: fill-box;
    transform-origin: center;
    transition:
      opacity 0.25s ease,
      transform 0.4s ease;
  }
  .moon {
    opacity: 0;
    transform: rotate(-70deg) scale(0.4);
  }
  .tsw.dark .sun {
    opacity: 0;
    transform: rotate(70deg) scale(0.4);
  }
  .tsw.dark .moon {
    opacity: 1;
    transform: none;
  }
  /* The switch still works and still reads; it just stops moving. */
  @media (prefers-reduced-motion: reduce) {
    .knob,
    .sun,
    .moon {
      transition-duration: 0.01ms;
    }
  }
  /* ---- about ---- */
  /* No button chrome: the icon is already a ring, and a bordered circle
     around it would read as a circle inside a circle. */
  .about {
    background: none;
    border: none;
    padding: 0;
    display: inline-flex;
    flex: none;
    cursor: pointer;
    border-radius: 50%;
  }
  .about:focus-visible {
    outline: 2px solid var(--link);
    outline-offset: 2px;
  }
  .about svg {
    height: 1.6em;
    width: auto;
    display: block;
    transition: transform 0.2s ease;
  }
  .about:hover svg {
    transform: scale(1.1);
  }
  /* currentColor, so the icon picks up the button's hover the same way the
     other header controls do. */
  .about {
    color: var(--ink-2);
  }
  .about:hover {
    color: var(--ink-1);
  }
  .bubble {
    fill: currentColor;
  }
  @media (prefers-reduced-motion: reduce) {
    .about svg {
      transition: none;
    }
  }
</style>
