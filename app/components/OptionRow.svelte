<script lang="ts">
  import { PRIO, type OptionEntry } from "../../src/schema";
  import { app } from "../lib/state.svelte";

  interface Props {
    entry: OptionEntry;
    /** storePath of the module being viewed — used to pick "its" definition. */
    highlightFile: string;
  }
  const { entry, highlightFile }: Props = $props();

  let open = $state(false);

  const prioChip = $derived.by(() => {
    if (!entry.customized || entry.highestPrio === undefined) return null;
    if (entry.highestPrio === PRIO.mkForce) return { label: "mkForce", cls: "force" };
    if (entry.highestPrio === PRIO.mkDefault) return { label: "mkDefault", cls: "soft" };
    if (entry.highestPrio !== PRIO.plain) return { label: `mkOverride ${entry.highestPrio}`, cls: "force" };
    return null;
  });

  const preview = $derived.by(() => {
    if (entry.valueError) return "⚠ value failed to evaluate";
    if (entry.value === undefined) {
      return entry.customized ? "(value skipped)" : (entry.defaultText ?? "—");
    }
    const s = JSON.stringify(entry.value);
    return s === undefined ? "—" : s;
  });

  const full = $derived(
    entry.value !== undefined ? JSON.stringify(entry.value, null, 2) : preview,
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  function enter(e: PointerEvent) {
    const { clientX, clientY } = e;
    timer = setTimeout(() => (app.tip = { x: clientX, y: clientY, entry }), 300);
  }
  function leave() {
    clearTimeout(timer);
    app.tip = null;
  }
</script>

<li>
  <button
    class="opt"
    class:customized={entry.customized}
    onclick={() => (open = !open)}
    onpointerenter={enter}
    onpointerleave={leave}
  >
    <span class="dot" class:hollow={!entry.customized}></span>
    <span class="loc mono">{entry.loc.join(".")}</span>
    {#if prioChip}<span class="chip {prioChip.cls}">{prioChip.label}</span>{/if}
    {#if entry.readOnly}<span class="chip ro">read-only</span>{/if}
    <span class="val mono" class:muted={!entry.customized}>{preview}</span>
  </button>
  {#if open}
    <pre class="mono">{full}</pre>
  {/if}
</li>

<style>
  .opt {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    background: none;
    border: none;
    border-radius: 6px;
    color: var(--ink-1);
    font: inherit;
    font-size: 0.8125rem;
    padding: 3px 6px;
    cursor: pointer;
    text-align: left;
  }
  .opt:hover {
    background: var(--page);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--link);
    flex: none;
  }
  .dot.hollow {
    background: transparent;
    border: 1.5px solid var(--ink-muted);
  }
  .mono {
    font-family: ui-monospace, monospace;
  }
  .loc {
    flex: none;
    max-width: 55%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .customized .loc {
    font-weight: 600;
  }
  .chip {
    flex: none;
    font-size: 0.625rem;
    border-radius: 8px;
    padding: 0 6px;
    line-height: 1rem;
  }
  .chip.force {
    background: color-mix(in srgb, var(--err) 18%, transparent);
    color: var(--err);
  }
  .chip.soft {
    background: color-mix(in srgb, var(--warn) 18%, transparent);
    color: var(--warn);
  }
  .chip.ro {
    background: var(--page);
    color: var(--ink-muted);
  }
  .val {
    margin-left: auto;
    font-size: 0.75rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 45%;
  }
  .val.muted {
    color: var(--ink-muted);
  }
  pre {
    background: var(--page);
    border: 1px solid var(--grid);
    border-radius: 6px;
    font-size: 0.75rem;
    margin: 2px 6px 6px 22px;
    padding: 8px 10px;
    overflow-x: auto;
    max-height: 300px;
    white-space: pre-wrap;
    word-break: break-all;
  }
</style>
