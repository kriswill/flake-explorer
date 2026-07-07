<script lang="ts">
  import { app } from "../lib/state.svelte";

  const { onClose }: { onClose: () => void } = $props();

  // Two panes: app info and the license notices (first-party + bundled deps).
  // The modal remounts per open (App's {#if}), so it always opens on info.
  let tab: "info" | "licenses" = $state("info");

  const about = $derived(app.about);
  const m = $derived(app.manifest);
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions --
     the backdrop is a pointer-only dismiss affordance; Escape (svelte:window
     below) and the ✕ button are the keyboard paths -->
<div class="overlay" onclick={(e) => e.target === e.currentTarget && onClose()}>
  <div class="modal" role="dialog" aria-modal="true" aria-label="About Flake Explorer">
    <header>
      <h2><span class="b1">Flake</span> <span class="b2">Explorer</span></h2>
      {#if about?.version}<span class="ver mono">v{about.version}</span>{/if}
      <button class="close" aria-label="Close" onclick={onClose}>×</button>
    </header>

    <div class="tabs" role="tablist" aria-label="About sections">
      <button class="seg" class:active={tab === "info"} role="tab" aria-selected={tab === "info"} onclick={() => (tab = "info")}>
        <!-- info circle -->
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
          <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.4" />
          <path d="M8 7.4v3.4M8 5.15v.02" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
        About
      </button>
      <button
        class="seg"
        class:active={tab === "licenses"}
        role="tab"
        aria-selected={tab === "licenses"}
        onclick={() => (tab = "licenses")}
      >
        <!-- scales of justice -->
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
          <path
            d="M8 2.5v11M5.8 13.5h4.4M3 4.5h10M3 4.5l-1.8 4M3 4.5l1.8 4M1.2 8.5a1.8 1.8 0 0 0 3.6 0M13 4.5l-1.8 4M13 4.5l1.8 4M11.2 8.5a1.8 1.8 0 0 0 3.6 0"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linejoin="round"
            stroke-linecap="round"
          />
        </svg>
        Licenses
      </button>
    </div>

    {#if tab === "info"}
      <p class="about">
        An interactive explorer for Nix flakes: browse every output and its module hierarchy, inspect
        options (customized vs. defaulted, <span class="mono">mkForce</span>/<span class="mono">mkDefault</span>
        priorities), and trace each module file back to the flake input that provides it — built for
        dendritic (flake-parts + import-tree) configurations, works on any flake.
      </p>
      {#if m}
        <p class="counts">
          Exploring <span class="mono">{m.flake.ref}</span> — {m.files.length} .nix files ·
          {Object.keys(m.inputs).length} inputs · {m.configurations.length} configurations
        </p>
      {/if}
      <p class="tool">
        <a href={about?.url ?? "https://github.com/kriswill/flake-explorer"} target="_blank" rel="noopener">
          github.com/kriswill/flake-explorer
        </a>
        {#if about?.license}· {about.license} license{/if}
        {#if about?.copyright}· {about.copyright}{/if}
      </p>
    {:else}
      <p class="lic-note">
        This page bundles the minified explorer app and the libraries below; the notices accompany
        them as their licenses require.
      </p>
      {#if about?.text}
        <details class="lic" open>
          <summary>{about.name} {about.version} · {about.license} — this app</summary>
          <pre>{about.text}</pre>
        </details>
      {/if}
      {#each about?.deps ?? [] as l (l.name)}
        <details class="lic">
          <summary>{l.name} {l.version}{l.license ? ` · ${l.license}` : ""}</summary>
          <pre>{l.text}</pre>
        </details>
      {:else}
        <p class="lic-note">License data unavailable in this build.</p>
      {/each}
    {/if}
  </div>
</div>
<svelte:window onkeydown={(e) => e.key === "Escape" && onClose()} />

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 5;
    display: flex;
    /* Top-anchored, not centered: the panes differ in height and the tab
       strip must stay put while only the bottom edge moves. */
    align-items: flex-start;
    justify-content: center;
    background: color-mix(in srgb, var(--page) 45%, transparent);
    backdrop-filter: blur(2px);
  }
  .modal {
    /* Wide enough for 80-column LICENSE texts in monospace without rewraps. */
    width: min(640px, calc(100vw - 32px));
    margin-top: 12vh;
    max-height: min(80vh, 680px);
    overflow-y: auto;
    background: var(--surface-1);
    border: 1px solid var(--grid);
    border-radius: 10px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
    padding: 16px 18px;
  }
  header {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin-bottom: 8px;
  }
  h2 {
    margin: 0;
    font-size: 1rem;
  }
  .b1 {
    color: var(--ink-1);
  }
  .b2 {
    color: var(--link);
  }
  .ver {
    color: var(--ink-muted);
    font-size: 0.75rem;
  }
  .mono {
    font-family: ui-monospace, monospace;
  }
  .close {
    margin-left: auto;
    flex: none;
    cursor: pointer;
    color: var(--ink-muted);
    font-size: 1.125rem;
    line-height: 1;
    border: 0;
    background: none;
    padding: 0;
  }
  .close:hover {
    color: var(--ink-1);
  }
  .tabs {
    display: flex;
    gap: 4px;
    padding-bottom: 8px;
    margin-bottom: 10px;
    border-bottom: 1px solid var(--grid);
  }
  .seg {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: none;
    border: 1px solid transparent;
    border-radius: 6px;
    color: var(--ink-2);
    font: inherit;
    font-size: 0.75rem;
    padding: 3px 8px;
    cursor: pointer;
  }
  .seg:hover {
    color: var(--ink-1);
  }
  .seg.active {
    background: var(--page);
    border-color: var(--grid);
    color: var(--ink-1);
  }
  .seg svg {
    flex: none;
  }
  .about {
    color: var(--ink-2);
    font-size: 0.8125rem;
    margin: 0 0 8px;
  }
  .counts {
    color: var(--ink-muted);
    font-size: 0.75rem;
    margin: 6px 0 12px;
  }
  .tool {
    color: var(--ink-muted);
    font-size: 0.75rem;
    margin-top: 6px;
  }
  .tool a {
    color: var(--ink-2);
  }
  .tool a:hover {
    color: var(--ink-1);
  }
  .lic-note {
    color: var(--ink-muted);
    font-size: 0.75rem;
    margin: 0 0 6px;
  }
  details.lic {
    margin: 2px 0;
    font-size: 0.75rem;
  }
  details.lic summary {
    cursor: pointer;
    color: var(--ink-2);
  }
  details.lic summary:hover {
    color: var(--ink-1);
  }
  details.lic pre {
    margin: 6px 0 10px;
    padding: 8px 10px;
    font: 0.65rem/1.5 ui-monospace, Menlo, monospace;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--ink-2);
    background: var(--page);
    border: 1px solid var(--grid);
    border-radius: 6px;
  }
</style>
