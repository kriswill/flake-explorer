<script lang="ts">
  import { app } from "../lib/state.svelte";
  import { colorFor } from "../lib/color";
  import { THEMES } from "../lib/themes";
  import type { TreeNode as Node } from "../lib/indexes";
  import Dot from "./Dot.svelte";
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
      <Dot dir={isDir} open={isDir && expanded} hollow={node.customized === 0} />
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
  /* Rail: vertical guide in the PARENT's color, spanning to the next sibling.
     Centered under the parent dot: left = row-pad(0.4) + dot-radius(0.325) - indent(1.15) - border/2. */
  li:not(:last-child)::after {
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
  /* Elbow: curved hook into this row, in the CHILD's own color.
     Top abuts the parent dot's bottom edge; right/bottom land on the child dot's left-center. */
  li::before {
    content: "";
    position: absolute;
    left: -0.4609rem;
    top: -0.3393rem;
    width: 0.8605rem;
    height: 1.0391rem;
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
    color: var(--ink-1);
    font: inherit;
    font-size: 0.8125rem;
    padding: 0.2rem 0.4rem;
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
