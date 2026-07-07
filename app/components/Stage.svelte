<script lang="ts">
  import { app } from "../lib/state.svelte";
  import DetailPanel from "./DetailPanel.svelte";
  import FileDetail from "./FileDetail.svelte";
  import Legend from "./Legend.svelte";

  const outputLeaf = $derived.by(() => {
    if (app.selection?.kind !== "output" || !app.manifest) return null;
    let node = app.manifest.outputs;
    for (const seg of app.selection.path) {
      if (node.kind !== "attrset" || !(seg in node.children)) return null;
      node = node.children[seg]!;
    }
    return node;
  });
</script>

<div class="stage">
  {#if app.selection?.kind === "module"}
    <DetailPanel configId={app.selection.configId} moduleId={app.selection.moduleId} />
  {:else if app.selection?.kind === "file"}
    <FileDetail fileId={app.selection.fileId} />
  {:else if app.selection?.kind === "output"}
    <h2 class="mono">{app.selection.path.join(".")}</h2>
    {#if outputLeaf?.kind === "leaf"}
      <p><span class="k">type</span> {outputLeaf.type}</p>
      {#if outputLeaf.name}<p><span class="k">name</span> <span class="mono">{outputLeaf.name}</span></p>{/if}
      {#if outputLeaf.description}<p>{outputLeaf.description}</p>{/if}
    {:else if outputLeaf?.kind === "omitted"}
      <p class="muted">Not evaluated for this system (re-extract with --all-systems).</p>
    {:else}
      <p class="muted">nix flake show could not classify this output.</p>
    {/if}
  {:else if app.selection?.kind === "config" && app.activeConfigId}
    {@const configId = app.activeConfigId}
    {@const ref = app.manifest?.configurations.find((c) => c.id === configId)}
    <h2 class="mono">{configId}</h2>
    {#if app.activeConfig}
      {@const opts = app.activeConfig.data.options}
      <p>
        {opts.length} options, {opts.filter((o) => o.customized).length} customized,
        {app.activeConfig.indexes.filesById.size} contributing files.
      </p>
      <p class="muted">Expand the configuration on the left and select a module to inspect its options.</p>
    {:else if app.configs[configId] === "loading"}
      <p class="muted">Extracting / loading options… (first run can take a minute or two)</p>
    {:else if ref?.status === "error"}
      <p class="err">{ref.error}</p>
    {/if}
  {:else if app.manifest}
    <h2>{app.manifest.flake.description ?? app.manifest.flake.ref}</h2>
    <p class="mono muted">{app.manifest.flake.ref}{app.manifest.flake.rev ? ` @ ${app.manifest.flake.rev.slice(0, 12)}` : ""}</p>
    <p>
      {app.manifest.files.length} .nix files ·
      {Object.keys(app.manifest.inputs).length} inputs ·
      {app.manifest.configurations.length} configurations
    </p>
    <Legend />
    {#if app.manifest.warnings.length}
      <details>
        <summary>{app.manifest.warnings.length} extraction warnings</summary>
        <ul>
          {#each app.manifest.warnings as w}<li class="mono warn">{w}</li>{/each}
        </ul>
      </details>
    {/if}
  {/if}
</div>

<style>
  .stage {
    padding: 16px;
    height: 100%;
    box-sizing: border-box;
  }
  h2 {
    margin: 0 0 8px;
    font-size: 1rem;
  }
  .mono {
    font-family: ui-monospace, monospace;
  }
  .muted {
    color: var(--ink-muted);
  }
  .err {
    color: var(--err);
  }
  .warn {
    color: var(--warn);
    font-size: 0.75rem;
  }
  .k {
    color: var(--ink-muted);
    margin-right: 6px;
  }
  p {
    margin: 4px 0;
    font-size: 0.8125rem;
  }
  details {
    margin-top: 10px;
    font-size: 0.8125rem;
  }
</style>
