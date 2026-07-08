<script lang="ts">
  import { app } from "../lib/state.svelte";
  import { colorFor } from "../lib/color";
  import { THEMES } from "../lib/themes";
  import type { FileTreeNode } from "../lib/indexes";
  import Dot from "./Dot.svelte";
  import FileTreeBranch from "./FileTreeBranch.svelte";

  interface Props {
    node: FileTreeNode;
    depth: number;
  }
  const { node, depth }: Props = $props();

  const gen = $derived(THEMES[app.themeIndex]!.gen);
  const q = $derived(app.q.toLowerCase());
  const rail = $derived(colorFor(node.colorKey, gen));

  /** Filter: a file matches on its full relPath; a folder if any child does. */
  function matches(n: FileTreeNode): boolean {
    if (q === "") return true;
    if (n.fileId) return n.path.toLowerCase().includes(q);
    return n.children.some(matches);
  }

  /** While filtering, matching subtrees render expanded regardless of state. */
  const isOpen = (n: FileTreeNode) => (q !== "" ? true : app.fileExpanded.has(n.id));

  function toggle(n: FileTreeNode) {
    if (app.fileExpanded.has(n.id)) app.fileExpanded.delete(n.id);
    else app.fileExpanded.add(n.id);
  }

  const isModSel = (fileId: string) =>
    app.selection?.kind === "module" && app.selection.moduleId === fileId;

  /** Scroll the auto-highlighted row into view when a module gets selected. */
  function reveal(el: HTMLElement, fileId: string) {
    $effect(() => {
      if (isModSel(fileId)) el.scrollIntoView?.({ block: "nearest" });
    });
  }
</script>

<ul class="tree" class:nested={depth > 0} style="--rail:{rail}">
  {#each node.children.filter(matches) as child (child.id)}
    <!-- Top-level folders get breathing room from the root-file list above. -->
    <li class:gap={depth === 0 && !child.fileId} style="--c:{colorFor(child.colorKey, gen)}">
      {#if child.fileId}
        <button
          class="row file"
          class:sel={app.selection?.kind === "file" && app.selection.fileId === child.fileId}
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
    padding-left: 1.15rem;
  }
  li {
    position: relative;
  }
  li.gap {
    margin-top: 8px;
  }
  /* Rail in the parent's color; elbows in each child's own color — only for
     nested levels (group roots hang directly under the section header).
     Centered under the parent dot: left = row-pad(0.4) + dot-radius(0.325) - indent(1.15) - border/2. */
  .nested > li:not(:last-child)::after {
    content: "";
    position: absolute;
    left: -0.4609rem;
    top: 0;
    bottom: 0;
    /* Mixed against the panel bg (not transparent) so it stays a consistent
       opaque color crossing hovered/selected rows instead of darkening. */
    border-left: 2px solid color-mix(in srgb, var(--rail, var(--grid)) 45%, var(--surface-1));
    pointer-events: none;
    z-index: 3;
  }
  /* Top abuts the parent dot's bottom edge; right/bottom land on the child dot's left-center. */
  .nested > li::before {
    content: "";
    position: absolute;
    left: -0.4609rem;
    top: -0.3036rem;
    width: 0.8605rem;
    height: 0.9676rem;
    border-left: 2px solid color-mix(in srgb, var(--c) 70%, var(--surface-1));
    border-bottom: 2px solid color-mix(in srgb, var(--c) 70%, var(--surface-1));
    border-bottom-left-radius: 0.8605rem;
    pointer-events: none;
    /* Above .row's z-index:2 so highlighted/selected rows don't clip the curve above them. */
    z-index: 3;
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
