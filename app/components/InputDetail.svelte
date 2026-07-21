<script lang="ts">
import { displayLabel, makeFileId } from "../../src/schema"
import { colorFor } from "../lib/color"
import type { FileMeta } from "../lib/indexes"
import { prefs } from "../lib/prefs.svelte"
import { segmentLines } from "../lib/segments"
import { app, loadedConfig } from "../lib/state.svelte"
import { THEMES } from "../lib/themes"
import AsyncSlot from "./AsyncSlot.svelte"
import Dot from "./Dot.svelte"
import InputProvenance from "./InputProvenance.svelte"
import SourceView from "./SourceView.svelte"

const { name }: { name: string } = $props()

const gen = $derived(THEMES[prefs.themeIndex]!.gen)
const input = $derived(app.manifest?.inputs[name] ?? null)

/** Self files whose source references inputs.<name> (manifest regex scan). */
const referencedBy = $derived([...(app.flakeIndexes?.inputRefsByInput.get(name) ?? [])].sort())

const MODULE_CAP = 50

/** Module files this input contributes, per configuration; null files = slot
 *  not loaded — the template branches on the slot itself for absent/loading/errored. */
const contributed = $derived.by(() => {
  const out: { configId: string; files: FileMeta[] | null }[] = []
  for (const c of app.manifest?.configurations ?? []) {
    const loaded = loadedConfig(app.configs[c.id])
    if (!loaded) {
      out.push({ configId: c.id, files: null })
      continue
    }
    const files = [...loaded.indexes.filesById.values()]
      .filter((m) => m.origin.kind === "input" && m.origin.input === name)
      .sort((a, b) => a.relPath.localeCompare(b.relPath))
    out.push({ configId: c.id, files })
  }
  return out
})

/** Outputs grafted onto this input's namespace (lib = nixpkgs.lib.extend …). */
const grafts = $derived((app.manifest?.grafts ?? []).filter((g) => g.input === name))

/**
 * This input's own inputs: direct-child entries from the deduped inputs
 * record, plus the follows edges dedup dropped (manifest.inputFollows).
 */
const transitive = $derived.by(() => {
  const prefix = `${name}/`
  const depth = name.split("/").length + 1
  const isDirectChild = (n: string) => n.startsWith(prefix) && n.split("/").length === depth
  const entries = Object.values(app.manifest?.inputs ?? {}).filter((i) => isDirectChild(i.name))
  const edges = (app.manifest?.inputFollows ?? []).filter((f) => isDirectChild(f.name))
  const deeper =
    Object.values(app.manifest?.inputs ?? {}).filter(
      (i) => i.name.startsWith(prefix) && i.name.split("/").length > depth,
    ).length +
    (app.manifest?.inputFollows ?? []).filter(
      (f) => f.name.startsWith(prefix) && f.name.split("/").length > depth,
    ).length
  const rows = [
    ...entries.map((i) => ({ kind: "entry" as const, name: i.name, info: i })),
    ...edges.map((f) => ({ kind: "follows" as const, name: f.name, target: f.target })),
  ].sort((a, b) => a.name.localeCompare(b.name))
  return { rows, deeper }
})

const childLabel = (full: string) => full.split("/").pop()!

/** The input's own flake.nix out of the store — same id scheme as option files. */
const fileId = $derived(makeFileId({ kind: "input", input: name }, "flake.nix"))
const contentSlot = $derived(app.fileContents[fileId])

$effect(() => {
  if (input?.storePath) app.loadFileContent(fileId, `${input.storePath}/flake.nix`)
})

const lines = $derived.by(() => {
  if (!contentSlot || typeof contentSlot !== "object" || !("text" in contentSlot)) return []
  return segmentLines(contentSlot.text, contentSlot.tokens)
})
</script>

<div class="input-detail">
  <div class="id-head">
    <div class="head" style="--c:{colorFor(name, gen)}">
      <Dot />
      <h2 class="mono">inputs.{name}</h2>
    </div>

    {#if !input}
      <p class="muted">No input named "{name}" in this flake.</p>
    {:else}
      <InputProvenance {input} />
    {/if}
  </div>

  {#if input}
    <div class="id-body">
      {#if !input.transitive}
        <div class="section">
          <h3>Referenced by <span class="count">{referencedBy.length}</span></h3>
          {#if referencedBy.length === 0}
            <p class="muted">No source references to inputs.{name} found in this flake's files.</p>
          {:else}
            <ul class="plain">
              {#each referencedBy as f (f)}
                <li>
                  <button class="link mono" onclick={() => app.select({ kind: "file", fileId: f })}>{displayLabel(f)}</button>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/if}

      <!-- Shown for transitive inputs too: they genuinely contribute (e.g. a
           snowglobe-lib/* module imported into a configuration). The per-config
           "load (may extract)" affordance is uniform with non-contributing
           direct inputs — cold, we can't tell "contributes nothing" from
           "nothing loaded yet" without loading the config anyway. -->
      {#if app.manifest?.configurations.length}
        <div class="section">
          <h3>Modules contributed</h3>
          {#each contributed as c (c.configId)}
            <div class="cfg">
              <span class="mono cfgname">{c.configId}</span>
              {#if c.files === null}
                {#if !app.configs[c.configId]}
                  <button class="link" onclick={() => void app.loadConfig(c.configId)}>
                    load to see contributed modules (may extract)
                  </button>
                {:else}
                  <!-- Only ever loading/errored here: a loaded slot means c.files !== null. -->
                  <AsyncSlot
                    value={app.configs[c.configId]}
                    loadingText="loading modules…"
                    retry={() => app.retryConfig(c.configId)}
                  >
                    {#snippet children()}{/snippet}
                  </AsyncSlot>
                {/if}
              {:else if c.files.length === 0}
                <span class="muted">no modules from this input</span>
              {:else}
                <span class="muted">{c.files.length} modules</span>
              {/if}
            </div>
            {#if c.files?.length}
              <ul class="plain indent">
                {#each c.files.slice(0, MODULE_CAP) as m (m.id)}
                  <li>
                    <button
                      class="link mono"
                      onclick={() => app.select({ kind: "module", configId: c.configId, moduleId: m.id })}
                    >{m.relPath}</button>
                  </li>
                {/each}
                {#if c.files.length > MODULE_CAP}
                  <li class="muted">… and {c.files.length - MODULE_CAP} more (see the configuration tree)</li>
                {/if}
              </ul>
            {/if}
          {/each}
        </div>
      {/if}

      {#if grafts.length}
        <div class="section">
          <h3>Outputs built from it</h3>
          <ul class="plain">
            {#each grafts as g (g.output)}
              <li>
                <button class="link mono" onclick={() => app.select({ kind: "output", path: [g.output] })}>{g.output}</button>
                <span class="muted">extends {name}.{g.output} — {g.added.length} added, {g.inherited} inherited</span>
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      {#if transitive.rows.length}
        <div class="section">
          <h3>
            Its inputs <span class="count">{transitive.rows.length}</span>
            {#if transitive.deeper}<span class="muted deepnote">+{transitive.deeper} deeper</span>{/if}
          </h3>
          <ul class="plain">
            {#each transitive.rows as row (row.name)}
              <li>
                {#if row.kind === "entry"}
                  <button class="link mono" onclick={() => app.select({ kind: "input", name: row.name })}>{childLabel(row.name)}</button>
                  <span class="muted mono">{row.info.type}{row.info.rev ? ` · ${row.info.rev.slice(0, 7)}` : ""}</span>
                {:else}
                  <span class="mono">{childLabel(row.name)}</span>
                  <span class="muted">→ follows</span>
                  {#if app.manifest?.inputs[row.target]}
                    <button class="link mono" onclick={() => app.select({ kind: "input", name: row.target })}>{row.target}</button>
                  {:else}
                    <span class="mono">{row.target}</span>
                  {/if}
                {/if}
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      <div class="section">
        <h3>flake.nix <span class="path mono">{input.storePath ? `${input.storePath}/flake.nix` : ""}</span></h3>
      </div>
      {#if !input.storePath}
        <p class="muted">
          {input.transitive
            ? "Source not available for transitive inputs beyond the fetched depth."
            : "Source not available (input was not fetched during extraction)."}
        </p>
      {:else}
        <AsyncSlot
          value={contentSlot}
          loadingText="loading source…"
          retry={() => app.retryFileContent(fileId, `${input.storePath}/flake.nix`)}
        >
          {#snippet children()}
            <SourceView {lines} />
          {/snippet}
        </AsyncSlot>
      {/if}
    </div>
  {/if}
</div>

<style>
  .input-detail {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .id-head {
    flex: none;
  }
  .id-body {
    flex: 1 1 0%;
    min-height: 0;
    overflow-y: auto;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  h2 {
    margin: 0;
    font-size: var(--text-sm);
    word-break: break-all;
  }
  .section {
    border-top: 1px solid var(--grid);
    padding-top: 10px;
    margin-top: 10px;
  }
  h3 {
    margin: 6px 0;
    font-size: var(--text-xs);
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .path {
    font-weight: 400;
    font-size: var(--text-3xs);
    color: var(--ink-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mono {
    font-family: ui-monospace, monospace;
  }
  .muted {
    color: var(--ink-muted);
    font-size: var(--text-2xs);
  }
  .count {
    color: var(--ink-muted);
    font-weight: normal;
  }
  .deepnote {
    font-weight: normal;
  }
  .plain {
    list-style: none;
    margin: 0 0 4px;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: var(--text-xs);
  }
  .plain li {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .plain.indent {
    margin-left: 14px;
  }
  .cfg {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: var(--text-xs);
    margin: 2px 0;
  }
  .cfgname {
    color: var(--ink-2);
  }
  .link {
    background: none;
    border: none;
    padding: 0;
    font-size: var(--text-xs);
    color: var(--link);
    cursor: pointer;
    text-align: left;
    word-break: break-all;
  }
  .link:hover {
    text-decoration: underline;
  }
</style>
