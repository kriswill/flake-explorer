<script lang="ts">
import { app } from "../lib/state.svelte";

const { onClose }: { onClose: () => void } = $props();

// Two panes: app info and the license notices (first-party + bundled deps).
// The modal remounts per open (App's {#if}), so it always opens on info.
let tab: "info" | "licenses" = $state("info");

const about = $derived(app.about);
const m = $derived(app.manifest);

/** Short context for the title, okflight-style: "kriswill/dotfiles". */
const shortRef = $derived.by(() => {
  const ref = m?.flake.ref ?? "";
  const parts = ref.replace(/\/+$/, "").split("/").filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join("/") : ref;
});

interface Row {
  label: string;
  count: number | string;
}
const rows = $derived.by((): Row[] => {
  if (!m) return [];
  const r: Row[] = [
    { label: ".nix files in the flake", count: m.files.length },
    { label: "Flake inputs (incl. transitive)", count: Object.keys(m.inputs).length },
    { label: "Configurations", count: m.configurations.length },
  ];
  for (const c of m.configurations) {
    if (c.status === "ok" && c.optionCount)
      r.push({ label: `${c.id} options`, count: c.optionCount });
  }
  if (m.warnings.length) r.push({ label: "Extraction warnings", count: m.warnings.length });
  return r;
});
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions --
     the backdrop is a pointer-only dismiss affordance; Escape (svelte:window
     below) and the ✕ button are the keyboard paths -->
<div class="overlay" onclick={(e) => e.target === e.currentTarget && onClose()}>
  <div class="modal" role="dialog" aria-modal="true" aria-label="About Flake Explorer">
    <header>
      <h2>
        {#if shortRef}<span class="ctx">{shortRef}</span>{/if}
        <span class="brand"><span class="b1">Flake</span><span class="b2">Explorer</span></span>
      </h2>
      <button class="close" aria-label="Close" onclick={onClose}>×</button>
    </header>

    <div class="tabs" role="tablist" aria-label="About sections">
      <button class="seg" class:active={tab === "info"} role="tab" aria-selected={tab === "info"} onclick={() => (tab = "info")}>
        <!-- info circle -->
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
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
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
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
        A navigable map of this flake — every output and its <b>module hierarchy</b>, each option's
        value and provenance (customized vs. defaulted, <span class="mono">mkForce</span>/<span class="mono">mkDefault</span>
        priorities), and every <span class="mono">.nix</span> file traced back to the flake input
        that provides it. Built for dendritic (flake-parts + import-tree) configurations; works on
        any flake.
      </p>

      {#if m}
        <h3>Exploring</h3>
        <p class="ref mono">{m.flake.ref}{m.flake.rev ? ` @ ${m.flake.rev.slice(0, 10)}` : ""}</p>
        <table>
          <tbody>
            {#each rows as r (r.label)}
              <tr><td>{r.label}</td><td class="num">{r.count}</td></tr>
            {/each}
          </tbody>
        </table>
      {/if}

      <p class="tool">
        Built with
        <a href={about?.url ?? "https://github.com/kriswill/flake-explorer"} target="_blank" rel="noopener">
          <span class="b1">Flake</span><span class="b2">Explorer</span></a
        >{about?.version ? ` v${about.version}` : ""}{about?.license ? ` · ${about.license} license` : ""}{about?.copyright
          ? ` · ${about.copyright}`
          : ""}
      </p>
    {:else}
      <p class="lic-note">
        This page bundles the minified explorer app and these libraries; the notices below accompany
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
    background: color-mix(in srgb, var(--page) 55%, transparent);
    backdrop-filter: blur(3px);
  }
  .modal {
    /* rem-sized so the box grows with the font-scale control instead of
       cramming scaled-up text into a fixed frame. 36rem fits 80-column
       LICENSE texts at the 0.66rem pre size without rewraps. */
    width: min(36rem, calc(100vw - 2rem));
    margin-top: 10vh;
    max-height: min(85vh, 42rem);
    overflow-y: auto;
    background: var(--surface-1);
    border: 1px solid var(--grid);
    border-radius: 12px;
    box-shadow: 0 18px 56px rgba(0, 0, 0, 0.4);
    padding: 1rem 1.25rem 1.125rem;
  }
  header {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin-bottom: 12px;
  }
  h2 {
    margin: 0;
    font-size: 1.0625rem;
    display: flex;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
  }
  .ctx {
    color: var(--ink-1);
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .brand {
    flex: none;
  }
  .b1 {
    color: var(--ink-1);
    font-weight: 700;
  }
  .b2 {
    color: var(--ink-muted);
    font-weight: 400;
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
    gap: 6px;
    padding-bottom: 12px;
    margin-bottom: 14px;
    border-bottom: 1px solid var(--grid);
  }
  .seg {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: none;
    border: 1px solid transparent;
    border-radius: 8px;
    color: var(--ink-muted);
    font: inherit;
    font-size: 0.8125rem;
    font-weight: 500;
    padding: 5px 12px;
    cursor: pointer;
  }
  .seg:hover {
    color: var(--ink-1);
  }
  .seg.active {
    background: var(--page);
    border-color: var(--grid);
    color: var(--ink-1);
    font-weight: 600;
  }
  .seg svg {
    flex: none;
  }
  .about {
    color: var(--ink-2);
    font-size: 0.84rem;
    line-height: 1.55;
    margin: 0 0 14px;
  }
  .about b {
    color: var(--ink-1);
    font-weight: 600;
  }
  h3 {
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--ink-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 0 0 4px;
  }
  .ref {
    color: var(--ink-muted);
    font-size: 0.75rem;
    margin: 0 0 6px;
    overflow-wrap: break-word;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8rem;
    margin-bottom: 14px;
  }
  td {
    padding: 4px 0;
    color: var(--ink-2);
    border-bottom: 1px solid color-mix(in srgb, var(--grid) 55%, transparent);
  }
  tr:last-child td {
    border-bottom: none;
  }
  td.num {
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: var(--ink-1);
    white-space: nowrap;
    padding-left: 12px;
  }
  .tool {
    color: var(--ink-muted);
    font-size: 0.75rem;
    margin: 6px 0 0;
  }
  .tool a {
    color: var(--ink-2);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .tool a:hover {
    color: var(--ink-1);
  }
  .lic-note {
    color: var(--ink-2);
    font-size: 0.8rem;
    line-height: 1.5;
    margin: 0 0 10px;
  }
  details.lic {
    margin: 4px 0;
    font-size: 0.8125rem;
  }
  details.lic summary {
    cursor: pointer;
    color: var(--ink-2);
    padding: 2px 0;
  }
  details.lic summary:hover {
    color: var(--ink-1);
  }
  details.lic pre {
    margin: 8px 0 12px;
    padding: 12px 14px;
    font: 0.66rem/1.55 ui-monospace, Menlo, monospace;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--ink-2);
    background: var(--page);
    border: 1px solid var(--grid);
    border-radius: 8px;
  }
</style>
