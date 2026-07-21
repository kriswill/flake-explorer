<script lang="ts" module>
import { inputNameOf, subtreeMatches as matchesBy, type TreeNode as Node } from "../lib/indexes"

/** Search filter: keep subtrees containing a label match (dirs included). */
export function subtreeMatches(n: Node, q: string): boolean {
  return matchesBy(
    n,
    q,
    (x) => x.label,
    (x) => x.children,
  )
}

/** Color key: input subtrees color by input name, everything else by node id. */
export function nodeColorKey(n: Node): string {
  return inputNameOf(n.id) ?? n.id
}
</script>

<script lang="ts">
  import { prefs } from "../lib/prefs.svelte";
  import { revealWhen } from "../lib/reveal.svelte";
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

  const gen = $derived(THEMES[prefs.themeIndex]!.gen);
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
  <!-- .connect/.railed: shared connector styles (tree-connectors.css). -->
  <li class="connect" style="--c:{color}" style:--rail={rail} class:railed={rail !== null}>
    <button
      class="row"
      class:hl={highlighted}
      class:sel={selected}
      use:revealWhen={() => selected}
      onclick={click}
      onpointerenter={() => node.fileId && (app.hover = { kind: "module", fileId: node.fileId })}
      onpointerleave={() => node.fileId && (app.hover = null)}
    >
      <Dot dir={isDir} open={isDir && expanded} hollow={node.customized === 0} />
      <!-- Trailing "/" on directory nodes: a dir and a file can be adjacent
           siblings under the same label (sops-nix's `sops` dir + `sops.nix`)
           and they behave differently on click. Matches the file tree. -->
      <span class="label">{node.label}{node.id.startsWith("dir:") ? "/" : ""}</span>
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
    /* Per-level cascade width — tree-connectors.css derives the connector
       geometry from it. Change only --indent; the curves stay anchored. */
    --indent: 0.9rem;
    list-style: none;
    margin: 0;
    padding: 0 0 0 var(--indent);
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
    font-size: var(--text-3xs);
    color: var(--ink-muted);
    background: var(--page);
    border-radius: 8px;
    padding: 0 6px;
    flex: none;
  }
</style>
