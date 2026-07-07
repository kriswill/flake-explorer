<script lang="ts">
  import { app } from "../lib/state.svelte";
  import { colorFor } from "../lib/color";
  import { THEMES } from "../lib/themes";
  import type { TreeNode as Node } from "../lib/indexes";
  import TreeNode from "./TreeNode.svelte";

  interface Props {
    node: Node;
    configId: string;
    depth: number;
  }
  const { node, configId, depth }: Props = $props();

  const gen = $derived(THEMES[app.themeIndex]!.gen);
  const isDir = $derived(node.children.length > 0);
  const expanded = $derived(app.expanded.has(node.id));
  const highlighted = $derived(app.highlightedNodes.has(node.id));
  const selected = $derived(
    app.selection?.kind === "module" &&
      app.selection.configId === configId &&
      app.selection.moduleId === node.fileId,
  );
  const colorKey = $derived(node.id.startsWith("input:") ? node.id.split(":")[1]! : node.id);
  const color = $derived(colorFor(colorKey, gen));

  /** Search filter: keep subtrees containing a label match. */
  function matches(n: Node, q: string): boolean {
    if (n.label.toLowerCase().includes(q)) return true;
    return n.children.some((c) => matches(c, q));
  }
  const visible = $derived(app.q === "" || matches(node, app.q.toLowerCase()));

  function click() {
    if (node.fileId) {
      app.select({ kind: "module", configId, moduleId: node.fileId });
    } else if (app.expanded.has(node.id)) {
      app.expanded.delete(node.id);
    } else {
      app.expanded.add(node.id);
    }
  }
</script>

{#if visible}
  <li style="--c:{color}">
    <button
      class="row"
      class:hl={highlighted}
      class:sel={selected}
      onclick={click}
      onpointerenter={() => node.fileId && (app.hover = { kind: "module", fileId: node.fileId })}
      onpointerleave={() => node.fileId && (app.hover = null)}
    >
      <span class="dot" class:dir={isDir} class:open={isDir && expanded} class:hollow={node.customized === 0}></span>
      <span class="label">{node.label}</span>
      {#if node.customized > 0}<span class="badge">{node.customized}</span>{/if}
    </button>
    {#if isDir && expanded}
      <ul class="tree" style="--rail:{color}">
        {#each node.children as child (child.id)}
          <TreeNode node={child} {configId} depth={depth + 1} />
        {/each}
      </ul>
    {/if}
  </li>
{/if}

<style>
  .tree {
    list-style: none;
    margin: 0;
    padding: 0 0 0 1.15rem;
  }
  li {
    position: relative;
  }
  /* Rail: vertical guide in the PARENT's color, spanning to the next sibling. */
  li:not(:last-child)::after {
    content: "";
    position: absolute;
    left: -0.78rem;
    top: 0;
    bottom: 0;
    border-left: 2px solid color-mix(in srgb, var(--rail, var(--grid)) 45%, transparent);
    pointer-events: none;
  }
  /* Elbow: curved hook into this row, in the CHILD's own color. */
  li::before {
    content: "";
    position: absolute;
    left: -0.78rem;
    top: -0.2rem;
    width: 0.55rem;
    height: 0.85rem;
    border-left: 2px solid color-mix(in srgb, var(--c) 70%, transparent);
    border-bottom: 2px solid color-mix(in srgb, var(--c) 70%, transparent);
    border-bottom-left-radius: 0.55rem;
    pointer-events: none;
    z-index: 1;
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
    font-size: 0.8125rem;
    padding: 2px 6px;
    border-radius: 8px;
    cursor: pointer;
    text-align: left;
    position: relative;
    z-index: 2;
  }
  .row:hover {
    background: var(--page);
  }
  .row.hl {
    background: color-mix(in srgb, var(--c) 18%, transparent);
  }
  .row.sel {
    background: var(--page);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c) 45%, transparent);
  }
  .row.sel .label {
    font-weight: 600;
  }
  /* Disclosure dot: the expand triangle is cut INTO the circle (surface
     color) and rotates to indicate orientation; leaves are plain dots. */
  .dot {
    width: 0.65rem;
    height: 0.65rem;
    border-radius: 50%;
    background: var(--c);
    flex: none;
    position: relative;
  }
  .dot.hollow {
    background: color-mix(in srgb, var(--c) 22%, transparent);
    box-shadow: inset 0 0 0 1.5px var(--c);
  }
  .dot.dir::after {
    content: "";
    position: absolute;
    left: 55%;
    top: 50%;
    translate: -50% -50%;
    border-left: 0.28rem solid var(--surface-1);
    border-top: 0.2rem solid transparent;
    border-bottom: 0.2rem solid transparent;
  }
  .dot.dir.open::after {
    left: 50%;
    top: 55%;
    border-left: 0.2rem solid transparent;
    border-right: 0.2rem solid transparent;
    border-top: 0.28rem solid var(--surface-1);
    border-bottom: none;
  }
  .dot.dir.hollow::after {
    border-left-color: var(--c);
  }
  .dot.dir.open.hollow::after {
    border-left-color: transparent;
    border-top-color: var(--c);
  }
  .label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .badge {
    margin-left: auto;
    font-size: 0.6875rem;
    color: var(--ink-muted);
    background: var(--page);
    border-radius: 8px;
    padding: 0 6px;
    flex: none;
  }
</style>
