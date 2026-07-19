<!--
  Shared loading / error / retry branch for the on-demand slots. ConfigSlot,
  PackageSlot, and FileContentSlot are all "loading" | SlotError | <loaded>
  (state.svelte.ts), and every detail pane used to re-implement the same
  three-way branch and .retry/.err styling — this component owns it once.
  The loaded shape renders through the children snippet.

  The notes carry the public class "slot-note" so a host component can adjust
  placement contextually (e.g. OutputsTree indents them to its tree rows).
-->
<script lang="ts" generics="T extends object">
import type { Snippet } from "svelte"
import type { SlotError } from "../lib/state.svelte"

interface Props {
  /** The slot; undefined (fetch not started yet) renders as loading. */
  value: "loading" | SlotError | T | undefined
  loadingText: string
  /** Omit when the view has no retry path; also hidden on permanent errors. */
  retry?: () => void
  children: Snippet<[T]>
}
const { value, loadingText, retry, children }: Props = $props()

const err = $derived(
  value && typeof value === "object" && "error" in value ? (value as SlotError) : null,
)
const loaded = $derived(
  value && typeof value === "object" && !("error" in value) ? (value as T) : null,
)
</script>

{#if err}
  <p class="slot-note err">
    {err.error.split("\n")[0]}
    {#if !err.permanent && retry}
      <button class="retry" onclick={retry}>retry</button>
    {/if}
  </p>
{:else if loaded}
  {@render children(loaded)}
{:else}
  <p class="slot-note muted">{loadingText}</p>
{/if}

<style>
  .slot-note {
    margin: 3px 0;
    font-size: 0.75rem;
  }
  .muted {
    color: var(--ink-muted);
  }
  .err {
    color: var(--err);
  }
  .retry {
    background: none;
    border: 1px solid var(--grid);
    border-radius: 4px;
    color: var(--ink-2);
    font-size: 0.6875rem;
    cursor: pointer;
    margin-left: 6px;
  }
</style>
