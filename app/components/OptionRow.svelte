<script lang="ts">
import { onDestroy } from "svelte"
import { type OptionEntry, PRIO } from "../../src/schema"
import { jsonSegments } from "../lib/json-segments"
import { app } from "../lib/state.svelte"
import Dot from "./Dot.svelte"

interface Props {
  entry: OptionEntry
  /** storePath of the module being viewed — used to pick "its" definition. */
  highlightFile: string
  /** When set, the option name links to its option page in this config. */
  configId?: string
}
const { entry, highlightFile, configId }: Props = $props()

let open = $state(false)

const prioChip = $derived.by(() => {
  if (!entry.customized || entry.highestPrio === undefined) return null
  if (entry.highestPrio === PRIO.mkForce) return { label: "mkForce", cls: "force" }
  if (entry.highestPrio === PRIO.mkDefault) return { label: "mkDefault", cls: "soft" }
  if (entry.highestPrio !== PRIO.plain)
    return { label: `mkOverride ${entry.highestPrio}`, cls: "force" }
  return null
})

/**
 * Merge-type options (attrsOf/listOf) fold every file's contribution into
 * one big value — meta.maintainers, e.g., merges to an 859-key attrset (one
 * per nixos module), which trips the extractor's breadth cap and shows as
 * "«attrs:859»". This file's own definition is usually small and never hit
 * that cap, so prefer it — it's also just the more relevant number: what
 * *this* file actually sets, not the whole config's merged result.
 */
const ownDefinition = $derived(entry.definitions.find((d) => d.file === highlightFile))
const shownValue = $derived(ownDefinition ? ownDefinition.value : entry.value)
const shownValueError = $derived(ownDefinition ? ownDefinition.valueError : entry.valueError)
const shownValueSkipped = $derived(ownDefinition ? ownDefinition.valueSkipped : entry.valueSkipped)

const preview = $derived.by(() => {
  if (shownValueError) return "⚠ value failed to evaluate"
  if (shownValueSkipped) return "(value skipped)"
  if (shownValue === undefined) return entry.defaultText ?? "—"
  const s = JSON.stringify(shownValue)
  return s === undefined ? "—" : s
})

const fullSegments = $derived(shownValue !== undefined ? jsonSegments(shownValue, "") : undefined)

let timer: ReturnType<typeof setTimeout> | undefined
function enter(e: PointerEvent) {
  const { clientX, clientY } = e
  timer = setTimeout(() => (app.tip = { x: clientX, y: clientY, entry }), 300)
}
function leave() {
  clearTimeout(timer)
  app.tip = null
}
// pointerleave never fires on DOM removal (selection change, filter toggle
// while hovering) — kill the pending timer AND release the tooltip if this
// row owns it, or it sticks anchored to a dead position.
onDestroy(() => {
  clearTimeout(timer)
  if (app.tip?.entry === entry) app.tip = null
})
</script>

<li>
  <div
    class="opt"
    class:customized={entry.customized}
    role="group"
    onpointerenter={enter}
    onpointerleave={leave}
  >
    <button class="expand dotbtn" aria-expanded={open} aria-label="toggle value" onclick={() => (open = !open)}>
      <Dot hollow={!entry.customized} />
    </button>
    {#if configId}
      <button
        class="loc mono loclink"
        onclick={() => app.select({ kind: "option", configId, loc: entry.loc })}
      >{entry.loc.join(".")}</button>
    {:else}
      <span class="loc mono">{entry.loc.join(".")}</span>
    {/if}
    {#if prioChip}<span class="chip {prioChip.cls}">{prioChip.label}</span>{/if}
    {#if entry.readOnly}<span class="chip ro">read-only</span>{/if}
    <button
      class="expand val mono"
      class:muted={!entry.customized}
      aria-expanded={open}
      onclick={() => (open = !open)}
    >{preview}</button>
  </div>
  {#if open}
    <pre class="mono">{#if fullSegments}{#each fullSegments as seg}<span class={seg.cls}>{seg.text}</span>{/each}{:else}{preview}{/if}</pre>
  {/if}
</li>

<style>
  .opt {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    box-sizing: border-box;
    border-radius: 6px;
    color: var(--ink-1);
    font-size: 0.8125rem;
    padding: 0.2rem 0.4rem;
  }
  .opt {
    --c: var(--link);
  }
  .opt:not(.customized) {
    --c: var(--ink-muted);
  }
  .opt:hover {
    background: var(--page);
  }
  /* Buttons inside the row inherit the row's look — the row used to BE one
     button; these carry its reset so the layout reads unchanged. */
  .expand,
  .loclink {
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    padding: 0;
    cursor: pointer;
    text-align: left;
  }
  .dotbtn {
    flex: none;
    display: flex;
    align-items: center;
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
  .loclink:hover {
    color: var(--link);
    text-decoration: underline;
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
  .tok-key {
    color: var(--code-property);
  }
  .tok-string {
    color: var(--code-json-string);
  }
  .tok-number {
    color: var(--code-number);
  }
  .tok-atom {
    color: var(--code-keyword);
  }
</style>
