<script lang="ts">
import { app, configError } from "../lib/state.svelte"
import FileDetail from "./FileDetail.svelte"
import InputDetail from "./InputDetail.svelte"
import Legend from "./Legend.svelte"
import ModuleDetail from "./ModuleDetail.svelte"
import ModuleOutputDetail from "./ModuleOutputDetail.svelte"
import OptionDetail from "./OptionDetail.svelte"
import OverlayDetail from "./OverlayDetail.svelte"
import PackageDetail from "./PackageDetail.svelte"

/** Module-flavored output categories routed to ModuleOutputDetail. */
const MODULE_OUTPUTS = new Set([
  "modules",
  "nixosModules",
  "darwinModules",
  "homeModules",
  "homeManagerModules",
  "flakeModules",
])

const outputLeaf = $derived.by(() => {
  if (app.selection?.kind !== "output" || !app.manifest) return null
  let node = app.manifest.outputs
  for (const seg of app.selection.path) {
    if (node.kind !== "attrset" || !(seg in node.children)) return null
    node = node.children[seg]!
  }
  return node
})

/** Same output-tree path, matched against the derivation-typed refs list. */
const packageRef = $derived.by(() => {
  if (app.selection?.kind !== "output" || !app.manifest) return null
  const path = app.selection.path
  return (
    app.manifest.packages.find(
      (p) => p.path.length === path.length && p.path.every((s, i) => s === path[i]),
    ) ?? null
  )
})
</script>

<div class="stage">
  {#if app.selection?.kind === "module"}
    <ModuleDetail configId={app.selection.configId} moduleId={app.selection.moduleId} />
  {:else if app.selection?.kind === "option"}
    <OptionDetail configId={app.selection.configId} loc={app.selection.loc} />
  {:else if app.selection?.kind === "file"}
    <FileDetail fileId={app.selection.fileId} />
  {:else if app.selection?.kind === "input"}
    <InputDetail name={app.selection.name} />
  {:else if app.selection?.kind === "output" && packageRef}
    <PackageDetail refId={packageRef.id} />
  {:else if app.selection?.kind === "output" && app.selection.path[0] === "overlays"}
    <OverlayDetail path={app.selection.path} leaf={outputLeaf} />
  {:else if app.selection?.kind === "output" && MODULE_OUTPUTS.has(app.selection.path[0] ?? "")}
    <ModuleOutputDetail path={app.selection.path} leaf={outputLeaf} />
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
    {:else if configError(app.configs[configId])}
      <p class="err">{configError(app.configs[configId])?.error}</p>
    {:else if ref?.status === "error"}
      <p class="err">{ref.error}</p>
    {/if}
  {:else if app.manifest}
    <h2>{app.manifest.flake.description ?? app.manifest.flake.ref}</h2>
    <p class="mono muted">{app.manifest.flake.ref}{app.manifest.flake.rev ? ` @ ${app.manifest.flake.rev.slice(0, 12)}` : ""}</p>
    {@const allInputs = Object.values(app.manifest.inputs)}
    {@const directInputs = allInputs.filter((i) => !i.transitive).length}
    {@const transitiveInputs =
      allInputs.length - directInputs + (app.manifest.inputFollows ?? []).length}
    <p>
      {app.manifest.files.length} .nix files ·
      {directInputs} inputs{transitiveInputs ? ` (+${transitiveInputs} transitive)` : ""} ·
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
