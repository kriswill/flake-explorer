<script lang="ts">
import { displayLabel, type OutputNode } from "../../src/schema"
import { app } from "../lib/state.svelte"

interface Props {
  /** Output-tree path: ["overlays"] (category root) or ["overlays", name]. */
  path: string[]
  /** The nix-flake-show node at `path`, when it exists. */
  leaf: OutputNode | null
}
const { path, leaf }: Props = $props()

const name = $derived(path[1] ?? null)

/** Union of evaluated attr names (outputNames) and scanned definition sites. */
const allNames = $derived.by(() => {
  const names = new Set<string>(app.manifest?.outputNames?.overlays ?? [])
  for (const d of app.manifest?.overlayDefs ?? []) names.add(d.name)
  return [...names].sort()
})

const defs = $derived((app.manifest?.overlayDefs ?? []).filter((d) => d.name === name))
const defFor = (n: string) => (app.manifest?.overlayDefs ?? []).find((d) => d.name === n) ?? null

/** Files importing a definition site — usually the file that attaches the overlay. */
const importedBy = (fileId: string) => [...(app.flakeIndexes?.importedBy.get(fileId) ?? [])].sort()
</script>

{#if !name}
  <h2 class="mono">overlays</h2>
  {#if allNames.length === 0}
    <p class="muted">No overlays found in this flake.</p>
  {:else}
    <ul class="plain">
      {#each allNames as n (n)}
        <li>
          <button class="link mono" onclick={() => app.select({ kind: "output", path: ["overlays", n] })}>{n}</button>
          {#if defFor(n)}<span class="muted mono">{displayLabel(defFor(n)!.file)}</span>{/if}
        </li>
      {/each}
    </ul>
  {/if}
{:else}
  <h2 class="mono">overlays.{name}</h2>
  {#if leaf?.kind === "leaf"}
    <p><span class="k">type</span> {leaf.type}</p>
  {/if}

  <section>
    <h3>Defined in</h3>
    {#if defs.length === 0}
      <p class="muted">
        Definition site not found — only <span class="mono">overlays.{name} = …</span> and
        <span class="mono">flake.overlays = &lbrace; … &rbrace;</span> source forms are scanned.
      </p>
    {:else}
      <ul class="plain">
        {#each defs as d (d.file)}
          <li>
            <button class="link mono" onclick={() => app.select({ kind: "file", fileId: d.file })}>{displayLabel(d.file)}</button>
          </li>
          {#each importedBy(d.file) as f (f)}
            <li class="indent">
              <span class="muted">imported by</span>
              <button class="link mono" onclick={() => app.select({ kind: "file", fileId: f })}>{displayLabel(f)}</button>
            </li>
          {/each}
        {/each}
      </ul>
    {/if}
  </section>
{/if}

<style>
  h2 {
    margin: 0 0 8px;
    font-size: 1rem;
  }
  .mono {
    font-family: ui-monospace, monospace;
  }
  .muted {
    color: var(--ink-muted);
    font-size: 0.8125rem;
  }
  .k {
    color: var(--ink-muted);
    margin-right: 6px;
  }
  p {
    margin: 4px 0;
    font-size: 0.8125rem;
  }
  section {
    border-top: 1px solid var(--grid);
    padding-top: 10px;
    margin-top: 12px;
  }
  h3 {
    margin: 0 0 6px;
    font-size: 0.8125rem;
  }
  .plain {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 0.8125rem;
  }
  .plain li {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .plain li.indent {
    margin-left: 14px;
  }
  .link {
    background: none;
    border: none;
    padding: 0;
    color: var(--link);
    font-size: 0.8125rem;
    cursor: pointer;
    text-align: left;
    word-break: break-all;
  }
  .link:hover {
    text-decoration: underline;
  }
</style>
