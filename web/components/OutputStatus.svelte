<script lang="ts">
import { humanBytes, outputSizes, outputState } from "../lib/graph-annotations"
import type { GraphNodeOutput, GraphTiers } from "../lib/schema"
import Dot from "./Dot.svelte"

interface Props {
  output: GraphNodeOutput
  tiers: GraphTiers
}
const { output, tiers }: Props = $props()

const state = $derived(outputState(output, tiers))
const sizes = $derived(outputSizes(output, tiers))

/**
 * The two MEASURED states get a dot; the two unmeasured ones get words and no
 * dot, because there is nothing to mark. Solid vs hollow vs absent is a SHAPE
 * channel, so nothing here depends on colour being perceived — the colour is a
 * second channel, and the marker's accessible name is a third.
 *
 * "not in your store" is deliberately muted rather than alarming: it is 78% of
 * measured outputs on real data. Colouring the majority state as a warning
 * would make every graph look broken.
 */
const MARKER: Record<string, { hollow: boolean; token: string; label: string } | null> = {
  "in-store": { hollow: false, token: "--ok", label: "in the store" },
  "not-in-store": { hollow: true, token: "--ink-muted", label: "not in your store" },
  "not-collected": null,
  "no-path": null,
}
const marker = $derived(MARKER[state] ?? null)

/** Never "would be built" — that is a dryRun claim and no real document has one. */
const NOTE: Record<string, string> = {
  "not-collected": "presence not collected",
  "no-path": "no output path recorded",
  "in-store": "",
  "not-in-store": "",
}
</script>

<span class="out">
  {#if marker}
    <span class="marker" role="img" aria-label="{output.name}: {marker.label}" style="--c:var({marker.token})">
      <Dot hollow={marker.hollow} />
    </span>
  {/if}
  <span class="out-name mono">{output.name}</span>
  {#if NOTE[state]}<span class="note muted">{NOTE[state]}</span>{/if}
  {#if state === "in-store"}
    {#if !sizes.collected}
      <span class="note muted">sizes not collected</span>
    {:else}
      <!-- nar and closure are DIFFERENT quantities and are labelled as such:
           on real data both live on exactly the same entries, so a swap would
           not surface as a missing value and only the label protects a reader. -->
      {#if sizes.narSize !== undefined}<span class="size muted">nar {humanBytes(sizes.narSize)}</span>{/if}
      {#if sizes.closureSize !== undefined}<span class="size muted">closure {humanBytes(sizes.closureSize)}</span>{/if}
    {/if}
  {/if}
</span>

<style>
  .out {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .marker {
    display: inline-flex;
    align-items: center;
  }
  .mono {
    font-family: ui-monospace, monospace;
  }
  .muted {
    color: var(--ink-muted);
  }
  .out-name,
  .note,
  .size {
    font-size: var(--text-3xs);
  }
</style>
