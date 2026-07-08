<script lang="ts">
  import type { GraftInfo, InputInfo, OutputNode } from "../../src/schema";
  import { app } from "../lib/state.svelte";
  import { colorFor } from "../lib/color";
  import { THEMES } from "../lib/themes";
  import Dot from "./Dot.svelte";
  import OutputBranch from "./OutputBranch.svelte";
  import TreeNode from "./TreeNode.svelte";

  const gen = $derived(THEMES[app.themeIndex]!.gen);

  /** nixos/darwin configuration categories get the module-tree treatment. */
  const configKind = (category: string) =>
    category === "nixosConfigurations" ? "nixos" : category === "darwinConfigurations" ? "darwin" : null;

  const configNames = (category: string): string[] => {
    const kind = configKind(category);
    return (app.manifest?.configurations ?? []).filter((c) => c.kind === kind).map((c) => c.name);
  };

  /**
   * A leaf/unknown node is real content; "omitted" just means "other system,
   * not evaluated here" and carries no information either way.
   */
  const hasContent = (node: OutputNode): boolean =>
    node.kind === "attrset" ? Object.values(node.children).some(hasContent) : node.kind !== "omitted";

  /** Categories with nothing under them (e.g. an unused `apps` or `overlays`) just clutter the tree. */
  const isEmptyCategory = (category: string, node: OutputNode): boolean =>
    configKind(category) ? configNames(category).length === 0 : !hasContent(node);

  /** Optional-chained twice: manifests from older extractors have no grafts field. */
  const graftFor = (category: string): GraftInfo | null =>
    app.manifest?.grafts?.find((g) => g.output === category) ?? null;

  /** Grafted outputs stay visible even when nix flake show omitted/emptied them. */
  const outputs = $derived.by(() => {
    const base: Record<string, OutputNode> =
      app.manifest?.outputs.kind === "attrset" ? { ...app.manifest.outputs.children } : {};
    for (const g of app.manifest?.grafts ?? []) {
      if (!(g.output in base)) base[g.output] = { kind: "unknown" };
    }
    return Object.entries(base).filter(([category, node]) => graftFor(category) || !isEmptyCategory(category, node));
  });

  /** Direct (root flake.lock) inputs only — what actually flows into modules. */
  const directInputs = $derived(Object.values(app.manifest?.inputs ?? {}).filter((i) => !i.transitive));

  const shortPin = (i: InputInfo) => i.rev?.slice(0, 7) ?? i.ref ?? i.type;

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

  /** Last path segment of the flake ref, e.g. "/home/k/src/nixos-config" -> "nixos-config". */
  const pathName = $derived.by(() => {
    const ref = app.manifest?.flake.ref.replace(/\/+$/, "") ?? "";
    return ref.slice(ref.lastIndexOf("/") + 1);
  });
</script>

<div class="panel">
  {#if app.manifest}
    <section class="path-section">
      <p class="path mono" title={app.manifest.flake.path}>{pathName}</p>
    </section>
  {/if}

  <section>
    <h3 class="eyebrow">description</h3>
    {#if app.manifest?.flake.description}
      <p class="desc">{app.manifest.flake.description}</p>
    {:else}
      <p class="desc muted">(none)</p>
    {/if}
  </section>

  <section>
    <h3 class="eyebrow">inputs <span class="ecount">{directInputs.length}</span></h3>
    <ul class="tree root">
      {#each directInputs as inp (inp.name)}
        <li>
          <button
            class="row"
            class:sel={app.selection?.kind === "input" && app.selection.name === inp.name}
            style="--c:{colorFor(inp.name, gen)}"
            onclick={() => app.select({ kind: "input", name: inp.name })}
          >
            <Dot />
            <span class="label">{inp.name}</span>
            <span class="badge mono">{shortPin(inp)}</span>
          </button>
        </li>
      {/each}
    </ul>
  </section>

  <section>
    <h3 class="eyebrow">outputs <span class="ecount">{outputs.length}</span></h3>
    <ul class="tree root">
      {#each outputs as [category, node] (category)}
        {@const kind = configKind(category)}
        {@const graft = graftFor(category)}
        <li>
          <button class="row cat" style="--c:{colorFor(category, gen)}" onclick={() => toggle(`out:${category}`)}>
            <Dot dir open={app.expanded.has(`out:${category}`)} />
            <span class="label">{category}</span>
            {#if graft}
              <span class="badge mono">{graft.input}.{graft.output} +{graft.added.length}</span>
            {/if}
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
            {:else if graft}
              <!-- Grafted namespace: only the keys this flake ADDS are shown;
                   the input's inherited names would just re-list the input. -->
              <ul class="tree">
                <li>
                  <p class="note">extends {graft.input}.{graft.output} · {graft.inherited} inherited keys hidden</p>
                </li>
                {#each graft.added as key (key)}
                  <li>
                    <button
                      class="row leaf"
                      class:sel={app.selection?.kind === "output" &&
                        app.selection.path.join(".") === `${category}.${key}`}
                      style="--c:{colorFor(category, gen)}"
                      onclick={() => app.select({ kind: "output", path: [category, key] })}
                    >
                      <Dot />
                      <span class="label">{key}</span>
                      <span class="type">added</span>
                    </button>
                  </li>
                {/each}
              </ul>
            {:else if node.kind === "attrset"}
              <OutputBranch {node} path={[category]} depth={1} />
            {:else if node.kind !== "leaf" && (app.manifest?.outputNames?.[category] ?? []).length}
              <!-- flake show gave up ("unknown") but the eval knows the attr names. -->
              <ul class="tree">
                {#each app.manifest?.outputNames?.[category] ?? [] as key (key)}
                  <li>
                    <button
                      class="row leaf"
                      class:sel={app.selection?.kind === "output" &&
                        app.selection.path.join(".") === `${category}.${key}`}
                      style="--c:{colorFor(category, gen)}"
                      onclick={() => app.select({ kind: "output", path: [category, key] })}
                    >
                      <Dot />
                      <span class="label">{key}</span>
                    </button>
                  </li>
                {/each}
              </ul>
            {:else}
              <p class="note">
                {node.kind === "leaf" ? node.type : node.kind === "omitted" ? "(other system)" : "(unevaluated)"}
              </p>
            {/if}
          {/if}
        </li>
      {/each}
    </ul>
  </section>
</div>

<style>
  .panel {
    padding: 8px 4px;
  }
  section + section {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--grid);
  }
  .path {
    margin: 0;
    padding: 0 8px;
    font-size: 0.8125rem;
    color: var(--link);
    word-break: break-all;
  }
  .eyebrow {
    margin: 0 0 4px;
    padding: 0 8px;
    font-size: 0.6875rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--ink-muted);
  }
  .ecount {
    font-weight: 400;
    letter-spacing: 0;
  }
  .desc {
    margin: 0;
    padding: 0 8px;
    font-size: 0.8125rem;
    color: var(--ink-2);
  }
  .desc.muted {
    color: var(--ink-muted);
  }
  .tree {
    list-style: none;
    margin: 0;
    /* Wide enough that TreeNode's connector pseudos (-0.78rem) stay inside. */
    padding: 0 0 0 1.15rem;
  }
  .root {
    padding: 0 4px;
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
  .type {
    margin-left: auto;
    color: var(--ink-muted);
    font-size: 0.6875rem;
    flex: none;
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
  .mono {
    font-family: ui-monospace, monospace;
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
