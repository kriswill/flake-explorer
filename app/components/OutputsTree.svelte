<script lang="ts">
  import { app } from "../lib/state.svelte";
  import { colorFor } from "../lib/color";
  import { THEMES } from "../lib/themes";
  import Dot from "./Dot.svelte";
  import OutputBranch from "./OutputBranch.svelte";
  import TreeNode from "./TreeNode.svelte";

  const gen = $derived(THEMES[app.themeIndex]!.gen);
  const outputs = $derived(
    app.manifest?.outputs.kind === "attrset" ? Object.entries(app.manifest.outputs.children) : [],
  );

  /** nixos/darwin configuration categories get the module-tree treatment. */
  const configKind = (category: string) =>
    category === "nixosConfigurations" ? "nixos" : category === "darwinConfigurations" ? "darwin" : null;

  const configNames = (category: string): string[] => {
    const kind = configKind(category);
    return (app.manifest?.configurations ?? []).filter((c) => c.kind === kind).map((c) => c.name);
  };

  function toggle(id: string) {
    if (app.expanded.has(id)) app.expanded.delete(id);
    else app.expanded.add(id);
  }

  function clickConfig(kind: string, name: string) {
    const id = `${kind}/${name}`;
    app.select({ kind: "config", configId: id });
    app.expanded.add(`cfg:${id}`);
  }

  const slotOf = (id: string) => {
    const slot = app.configs[id];
    return slot && typeof slot === "object" && "data" in slot ? slot : null;
  };
</script>

<ul class="tree root">
  {#each outputs as [category, node] (category)}
    {@const kind = configKind(category)}
    <li>
      <button class="row cat" style="--c:{colorFor(category, gen)}" onclick={() => toggle(`out:${category}`)}>
        <Dot dir open={app.expanded.has(`out:${category}`)} />
        <span class="label">{category}</span>
      </button>
      {#if app.expanded.has(`out:${category}`)}
        {#if kind}
          <ul class="tree">
            {#each configNames(category) as name (name)}
              {@const id = `${kind}/${name}`}
              {@const loaded = slotOf(id)}
              <li>
                <button
                  class="row cfg"
                  class:sel={app.selection?.kind === "config" && app.selection.configId === id}
                  style="--c:{colorFor(id, gen)}"
                  onclick={() => clickConfig(kind, name)}
                >
                  <Dot dir open={app.expanded.has(`cfg:${id}`)} />
                  <span class="label">{name}</span>
                  {#if loaded}
                    <span class="badge">{loaded.data.options.filter((o) => o.customized).length}</span>
                  {/if}
                </button>
                {#if app.expanded.has(`cfg:${id}`)}
                  {#if app.configs[id] === "loading"}
                    <p class="note">loading options…</p>
                  {:else if app.configs[id] && typeof app.configs[id] === "object" && "error" in app.configs[id]}
                    <p class="note err">
                      {app.configs[id].error.split("\n")[0]}
                      <button class="retry" onclick={() => app.retryConfig(id)}>retry</button>
                    </p>
                  {:else if loaded}
                    <ul class="tree">
                      {#each loaded.indexes.tree.children as child (child.id)}
                        <TreeNode node={child} configId={id} depth={0} />
                      {/each}
                    </ul>
                  {/if}
                {/if}
              </li>
            {/each}
          </ul>
        {:else if node.kind === "attrset"}
          <OutputBranch {node} path={[category]} depth={1} />
        {:else}
          <p class="note">
            {node.kind === "leaf" ? node.type : node.kind === "omitted" ? "(other system)" : "(unevaluated)"}
          </p>
        {/if}
      {/if}
    </li>
  {/each}
</ul>

<style>
  .tree {
    list-style: none;
    margin: 0;
    /* Wide enough that TreeNode's connector pseudos (-0.78rem) stay inside. */
    padding: 0 0 0 1.15rem;
  }
  .root {
    padding: 8px 4px;
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
    padding: 3px 6px;
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
  .cat .label {
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
  }
  .note {
    color: var(--ink-muted);
    font-size: 0.75rem;
    margin: 2px 0 2px 24px;
  }
  .note.err {
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
