<script lang="ts">
import type { OutputNode } from "../../src/schema"
import type { FileMeta } from "../lib/indexes"
import { resolveFile } from "../lib/indexes"
import { app, loadedConfig } from "../lib/state.svelte"
import AsyncSlot from "./AsyncSlot.svelte"

interface Props {
  /** Output-tree path, e.g. ["modules"], ["modules","nixos"], ["modules","nixos","zsh"]. */
  path: string[]
  /** The nix-flake-show node at `path`, when it exists. */
  leaf: OutputNode | null
}
const { path, leaf }: Props = $props()

const dotted = $derived(path.join("."))
/**
 * The module system stamps ", via option <path>" with the option path the
 * module was imported through — flake-parts' dendritic pattern yields
 * "flake.modules.nixos.zsh" for output modules.nixos.zsh. Match both the
 * bare output path and its flake.-prefixed form.
 */
const viaKeys = $derived([dotted, `flake.${dotted}`])
const matchesLeaf = (via: string) => viaKeys.includes(via)
const matchesUnder = (via: string) => viaKeys.some((k) => via.startsWith(`${k}.`))

interface FileHit {
  meta: FileMeta
  declares: number
  defines: number
}

/**
 * Per configuration: the module files whose option declarations/definitions
 * carry a matching via path. null files = config not loaded (the template
 * offers load-in-place, like InputDetail's "modules contributed").
 */
const perConfig = $derived.by(() => {
  const out: { configId: string; files: FileHit[] | null }[] = []
  if (!app.manifest || !app.flakeIndexes) return out
  for (const c of app.manifest.configurations) {
    const loaded = loadedConfig(app.configs[c.id])
    if (!loaded) {
      out.push({ configId: c.id, files: null })
      continue
    }
    const hits = new Map<string, FileHit>()
    const add = (file: string, role: "declares" | "defines") => {
      const meta = resolveFile(file, app.manifest!, app.flakeIndexes!)
      let hit = hits.get(meta.id)
      if (!hit) {
        hit = { meta, declares: 0, defines: 0 }
        hits.set(meta.id, hit)
      }
      hit[role]++
    }
    for (const o of loaded.data.options) {
      for (const d of o.declarations) {
        if (d.via && (matchesLeaf(d.via) || matchesUnder(d.via))) add(d.file, "declares")
      }
      for (const d of o.definitions) {
        if (d.via && (matchesLeaf(d.via) || matchesUnder(d.via))) add(d.file, "defines")
      }
    }
    out.push({
      configId: c.id,
      files: [...hits.values()].sort((a, b) => a.meta.relPath.localeCompare(b.meta.relPath)),
    })
  }
  return out
})

/**
 * Child module names under this path: distinct next via segments from loaded
 * configs, plus (at the top level) the evaluated attr names from outputNames.
 */
const childNames = $derived.by(() => {
  const names = new Set<string>()
  if (path.length === 1) {
    for (const n of app.manifest?.outputNames?.[path[0]!] ?? []) names.add(n)
  }
  for (const c of perConfig) {
    if (!c.files) continue
    const loaded = loadedConfig(app.configs[c.configId])
    if (!loaded) continue
    for (const o of loaded.data.options) {
      for (const d of [...o.declarations, ...o.definitions]) {
        if (!d.via || !matchesUnder(d.via)) continue
        const key = viaKeys.find((k) => d.via!.startsWith(`${k}.`))!
        const next = d.via.slice(key.length + 1).split(".")[0]!
        names.add(next)
      }
    }
  }
  return [...names].sort()
})

const anyLoaded = $derived(perConfig.some((c) => c.files !== null))
const anyHits = $derived(perConfig.some((c) => c.files?.length))
</script>

<h2 class="mono">{dotted}</h2>
{#if leaf?.kind === "leaf"}
  <p><span class="k">type</span> {leaf.type}</p>
{/if}

{#if childNames.length}
  <section>
    <h3>Modules <span class="count">{childNames.length}</span></h3>
    <ul class="plain">
      {#each childNames as n (n)}
        <li>
          <button class="link mono" onclick={() => app.select({ kind: "output", path: [...path, n] })}>{n}</button>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<section>
  <h3>Used by configurations</h3>
  <p class="mergenote muted">
    Files imported via <span class="mono">{viaKeys[1]}</span> (module-system provenance), with the
    option counts they declare or set there.
  </p>
  {#each perConfig as c (c.configId)}
    <div class="cfg">
      <span class="mono cfgname">{c.configId}</span>
      {#if c.files === null}
        {#if !app.configs[c.configId]}
          <button class="link" onclick={() => void app.loadConfig(c.configId)}>
            load to see usage (may extract)
          </button>
        {:else}
          <AsyncSlot
            value={app.configs[c.configId]}
            loadingText="loading…"
            retry={() => app.retryConfig(c.configId)}
          >
            {#snippet children()}{/snippet}
          </AsyncSlot>
        {/if}
      {:else if c.files.length === 0}
        <span class="muted">not used</span>
      {/if}
    </div>
    {#if c.files?.length}
      <ul class="plain indent">
        {#each c.files as hit (hit.meta.id)}
          <li>
            <button
              class="link mono"
              onclick={() => app.select({ kind: "module", configId: c.configId, moduleId: hit.meta.id })}
            >{hit.meta.relPath}</button>
            <span class="muted">
              {#if hit.defines}{hit.defines} set{/if}{#if hit.defines && hit.declares} · {/if}{#if hit.declares}{hit.declares} declared{/if}
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  {/each}
  {#if anyLoaded && !anyHits}
    <p class="muted">
      No module-system provenance found for this output in the loaded configurations — plain
      (non-flake-parts) module outputs carry no via stamps.
    </p>
  {/if}
</section>

<style>
  h2 {
    margin: 0 0 8px;
    font-size: 1rem;
  }
  .mono {
    font-family: ui-monospace, monospace;
  }
  .muted {
    color: var(--ink-muted);
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
  section {
    border-top: 1px solid var(--grid);
    padding-top: 10px;
    margin-top: 12px;
  }
  h3 {
    margin: 0 0 6px;
    font-size: 0.8125rem;
  }
  .count {
    color: var(--ink-muted);
    font-weight: normal;
  }
  .mergenote {
    margin: 0 0 6px;
  }
  .plain {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 0.8125rem;
  }
  .plain li {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .plain.indent {
    margin-left: 14px;
    margin-bottom: 6px;
  }
  .cfg {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 0.8125rem;
    margin: 2px 0;
  }
  .cfgname {
    color: var(--ink-2);
  }
  .link {
    background: none;
    border: none;
    padding: 0;
    color: var(--link);
    font-size: 0.8125rem;
    cursor: pointer;
    text-align: left;
    word-break: break-all;
  }
  .link:hover {
    text-decoration: underline;
  }
</style>
