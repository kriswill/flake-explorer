<script lang="ts">
import { colorFor } from "../lib/color"
import type { FileTreeNode } from "../lib/indexes"
import { app } from "../lib/state.svelte"
import { THEMES } from "../lib/themes"
import Dot from "./Dot.svelte"
import FileTreeBranch from "./FileTreeBranch.svelte"

interface Props {
  node: FileTreeNode
  depth: number
}
const { node, depth }: Props = $props()

const gen = $derived(THEMES[app.themeIndex]!.gen)
const q = $derived(app.q.toLowerCase())

/** Filter: a file matches on its full relPath; a folder if any child does. */
function matches(n: FileTreeNode): boolean {
  if (q === "") return true
  if (n.fileId) return n.path.toLowerCase().includes(q)
  return n.children.some(matches)
}

const kids = $derived(node.children.filter(matches))

/** While filtering, matching subtrees render expanded regardless of state. */
const isOpen = (n: FileTreeNode) => (q !== "" ? true : app.fileExpanded.has(n.id))

function toggle(n: FileTreeNode) {
  if (app.fileExpanded.has(n.id)) app.fileExpanded.delete(n.id)
  else app.fileExpanded.add(n.id)
}

const isModSel = (fileId: string) =>
  app.selection?.kind === "module" && app.selection.moduleId === fileId

const isFileSel = (fileId: string) =>
  app.selection?.kind === "file" && app.selection.fileId === fileId

/** Scroll the auto-highlighted row into view when it becomes selected —
    either directly (a file link elsewhere in the app) or as a config's
    module (the left tree's module selection mirrored here). */
function reveal(el: HTMLElement, fileId: string) {
  $effect(() => {
    if (isModSel(fileId) || isFileSel(fileId)) el.scrollIntoView?.({ block: "nearest" })
  })
}
</script>

<ul class="tree" class:nested={depth > 0}>
  {#each kids as child, i (child.id)}
    <!-- Top-level folders get breathing room from the root-file list above.
         .connect/.railed: shared connector styles (tree-connectors.css) —
         nested levels only, group roots hang directly under the section
         header. --rail: color of the vertical line crossing this row down to
         the NEXT visible sibling — a rail is always owned by the child it
         leads to. -->
    <li
      class:gap={depth === 0 && !child.fileId}
      class:connect={depth > 0}
      class:railed={depth > 0 && i < kids.length - 1}
      style="--c:{colorFor(child.colorKey, gen)}"
      style:--rail={i < kids.length - 1 ? colorFor(kids[i + 1]!.colorKey, gen) : null}
    >
      {#if child.fileId}
        <button
          class="row file"
          class:sel={isFileSel(child.fileId)}
          class:rel={app.highlightedFiles.has(child.fileId)}
          class:hov={app.hover?.kind === "module" && app.hover.fileId === child.fileId}
          class:modsel={isModSel(child.fileId)}
          use:reveal={child.fileId}
          onclick={() => app.select({ kind: "file", fileId: child.fileId! })}
          onpointerenter={() => (app.hover = { kind: "file", fileId: child.fileId! })}
          onpointerleave={() => (app.hover = null)}
        >
          <Dot />
          <span class="label mono">{child.label}</span>
        </button>
      {:else}
        <button class="row dir" onclick={() => toggle(child)}>
          <Dot dir open={isOpen(child)} hollow />
          <span class="label mono">{child.label}/</span>
        </button>
        {#if isOpen(child)}
          <FileTreeBranch node={child} depth={depth + 1} />
        {/if}
      {/if}
    </li>
  {/each}
</ul>

<style>
  .tree {
    list-style: none;
    margin: 0;
    padding: 0 0 0 0.35rem;
  }
  .tree.nested {
    /* Per-level cascade width — tree-connectors.css derives the connector
       geometry from it. The vertical elbow constants are overridden here:
       this tree's rows are shorter (0.75rem labels vs the module tree's
       0.8125rem), so the shared defaults would miss the dots. */
    --indent: 0.9rem;
    --elbow-h: 0.664rem;
    --elbow-first-top: -0.3036rem;
    --elbow-first-h: 0.9676rem;
    padding-left: var(--indent);
  }
  li.gap {
    margin-top: 8px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    background: none;
    border: none;
    border-radius: 8px;
    color: var(--ink-1);
    font: inherit;
    padding: 0.2rem 0.4rem;
    cursor: pointer;
    text-align: left;
    position: relative;
    z-index: 2;
  }
  .row.file:hover,
  .row.hov {
    background: color-mix(in srgb, var(--c) 14%, transparent);
  }
  .row.rel {
    background: color-mix(in srgb, var(--c) 22%, transparent);
  }
  .row.modsel {
    background: color-mix(in srgb, var(--c) 22%, transparent);
    box-shadow: inset 2px 0 0 var(--c);
  }
  .row.sel {
    background: var(--page);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c) 45%, transparent);
  }
  .row.sel .label,
  .row.modsel .label {
    font-weight: 600;
  }
  .row.dir:hover {
    background: var(--page);
  }
  .row.dir .label {
    color: var(--ink-muted);
  }
  .label {
    font-size: 0.75rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mono {
    font-family: ui-monospace, monospace;
  }
</style>
