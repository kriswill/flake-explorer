<script lang="ts">
import type { OutputNode } from "../../src/schema"
import { revealWhen } from "../lib/reveal.svelte"
import { app } from "../lib/state.svelte"
import Dot from "./Dot.svelte"
import OutputBranch from "./OutputBranch.svelte"

interface Props {
  node: OutputNode & { kind: "attrset" }
  path: string[]
  depth: number
}
const { node, path, depth }: Props = $props()

const idOf = (name: string) => `out:${[...path, name].join(".")}`

function toggle(name: string) {
  const id = idOf(name)
  if (app.expanded.has(id)) app.expanded.delete(id)
  else app.expanded.add(id)
}

const isSel = (name: string) =>
  app.selection?.kind === "output" && app.selection.path.join(".") === [...path, name].join(".")
</script>

<ul class="tree">
  {#each Object.entries(node.children) as [name, child] (name)}
    <li>
      {#if child.kind === "attrset"}
        <button class="row" onclick={() => toggle(name)}>
          <Dot dir open={app.expanded.has(idOf(name))} />
          <span class="label">{name}</span>
          <span class="type">{Object.keys(child.children).length}</span>
        </button>
        {#if app.expanded.has(idOf(name))}
          <OutputBranch node={child} path={[...path, name]} depth={depth + 1} />
        {/if}
      {:else}
        <!-- Deep links (#/o/…) expand the ancestor chain; this is what
             actually brings the selected leaf into view. -->
        <button
          class="row leaf"
          class:dim={child.kind !== "leaf"}
          class:sel={isSel(name)}
          use:revealWhen={() => isSel(name)}
          onclick={() => app.select({ kind: "output", path: [...path, name] })}
        >
          <Dot hollow={child.kind !== "leaf"} />
          <span class="label">{name}</span>
          {#if child.kind === "leaf"}
            <span class="type">{child.type}</span>
          {:else if child.kind === "omitted"}
            <span class="type">(other system)</span>
          {:else}
            <span class="type">(unevaluated)</span>
          {/if}
        </button>
      {/if}
    </li>
  {/each}
</ul>

<style>
  .tree {
    list-style: none;
    margin: 0;
    padding: 0 0 0 14px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    background: none;
    border: none;
    color: var(--ink-1);
    font: inherit;
    font-size: var(--text-xs);
    padding: 0.2rem 0.4rem;
    border-radius: 6px;
    cursor: pointer;
    text-align: left;
  }
  .row:hover {
    background: var(--page);
  }
  .row.sel {
    background: var(--page);
    box-shadow: inset 2px 0 0 var(--link);
  }
  .row.dim .label {
    color: var(--ink-muted);
  }
  .label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .type {
    margin-left: auto;
    color: var(--ink-muted);
    font-size: var(--text-3xs);
    flex: none;
  }
</style>
