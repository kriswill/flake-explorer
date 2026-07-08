<script lang="ts" module>
  import type { TreeNode as Node } from "../lib/indexes";

  /** Search filter: keep subtrees containing a label match. */
  export function subtreeMatches(n: Node, q: string): boolean {
    if (n.label.toLowerCase().includes(q)) return true;
    return n.children.some((c) => subtreeMatches(c, q));
  }

  /** Color key: input subtrees color by input name, everything else by node id. */
  export function nodeColorKey(n: Node): string {
    return n.id.startsWith("input:") ? n.id.split(":")[1]! : n.id;
  }
</script>

<script lang="ts">
  import { app } from "../lib/state.svelte";
  import { colorFor } from "../lib/color";
  import { THEMES } from "../lib/themes";
  import Dot from "./Dot.svelte";
  import TreeNode from "./TreeNode.svelte";

  interface Props {
    node: Node;
    configId: string;
    depth: number;
    /**
     * Color of the vertical rail crossing this row on its way down to the
     * NEXT sibling (a rail always belongs to the child it leads to, never
     * the parent); null on the last visible sibling — no rail.
     */
    rail?: string | null;
  }
  const { node, configId, depth, rail = null }: Props = $props();

  const gen = $derived(THEMES[app.themeIndex]!.gen);
  const isDir = $derived(node.children.length > 0);
  const expanded = $derived(app.expanded.has(node.id));
  const highlighted = $derived(app.highlightedNodes.has(node.id));
  const selected = $derived(
    app.selection?.kind === "module" &&
      app.selection.configId === configId &&
      app.selection.moduleId === node.fileId,
  );
  const color = $derived(colorFor(nodeColorKey(node), gen));

  const visible = $derived(app.q === "" || subtreeMatches(node, app.q.toLowerCase()));

  /** Visible children — filtered HERE so each child's rail color can be the
      next VISIBLE sibling's, not a filtered-out one's. */
  const kids = $derived(
    app.q === "" ? node.children : node.children.filter((c) => subtreeMatches(c, app.q.toLowerCase())),
  );

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
  <li style="--c:{color}" style:--rail={rail} class:railed={rail !== null}>
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
      <ul class="tree">
        {#each kids as child, i (child.id)}
          <TreeNode
            node={child}
            {configId}
            depth={depth + 1}
            rail={i < kids.length - 1 ? colorFor(nodeColorKey(kids[i + 1]!), gen) : null}
          />
        {/each}
      </ul>
    {/if}
  </li>
{/if}

<style>
  .tree {
    /* Per-level cascade width. Curve geometry below is derived from this via
       calc() — row-pad(0.4) + dot-radius(0.325) - indent - border/2, solved
       against the shipped 1.15rem/-0.4609rem/0.8605rem numbers to recover
       the two indent-independent constants (0.6891, 0.2895). Change only
       --indent; the curves stay correctly anchored to both dots. */
    --indent: 0.9rem;
    list-style: none;
    margin: 0;
    padding: 0 0 0 var(--indent);
  }
  li {
    position: relative;
  }
  /* Rail: vertical guide crossing this row down to the NEXT sibling, in that
     next sibling's color (--rail, passed per-node) — a connector line is
     always owned by the child it leads to. Centered under the parent dot. */
  li.railed::after {
    content: "";
    position: absolute;
    left: calc(0.6891rem - var(--indent));
    top: 0;
    bottom: 0;
    /* Mixed against the panel bg (not transparent) so it stays a consistent
       opaque color crossing hovered/selected rows instead of darkening. */
    border-left: 2px solid color-mix(in srgb, var(--rail) 45%, var(--surface-1));
    pointer-events: none;
    z-index: 3;
  }
  /* Elbow: curved hook into this row, in the CHILD's own color, ending on the
     child dot's left edge. Starts at the row's own top — exactly where the
     preceding sibling's rail ends — so it never repaints the rail above it.
     Two-value (h v) radius fills the whole box as one quarter-ellipse: the
     vertical tangent at the top makes it branch smoothly off the rail. */
  li::before {
    content: "";
    position: absolute;
    left: calc(0.6891rem - var(--indent));
    top: 0;
    width: calc(var(--indent) - 0.2895rem);
    height: 0.6998rem;
    border-left: 2px solid color-mix(in srgb, var(--c) 70%, var(--surface-1));
    border-bottom: 2px solid color-mix(in srgb, var(--c) 70%, var(--surface-1));
    border-bottom-left-radius: calc(var(--indent) - 0.2895rem) 0.6998rem;
    pointer-events: none;
    /* Above rails (3) — the child's elbow always wins where they meet — and
       above .row's z-index:2 so highlighted rows don't clip the curve. */
    z-index: 4;
  }
  /* First child: no sibling rail above, so reach up to abut the parent dot's bottom edge. */
  li:first-child::before {
    top: -0.3393rem;
    height: 1.0391rem;
    border-bottom-left-radius: calc(var(--indent) - 0.2895rem) 1.0391rem;
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
