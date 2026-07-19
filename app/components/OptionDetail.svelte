<script lang="ts">
import { PRIO } from "../../src/schema"
import { type FileMeta, resolveFile } from "../lib/indexes"
import { jsonSegments } from "../lib/json-segments"
import { app, configError, loadedConfig } from "../lib/state.svelte"

interface Props {
  configId: string
  loc: string[]
}
const { configId, loc }: Props = $props()

const locStr = $derived(loc.join("."))
const slot = $derived(app.configs[configId])
const cfg = $derived(loadedConfig(slot))
const err = $derived(configError(slot))

const entry = $derived.by(() => {
  if (!cfg) return null
  const i = cfg.indexes.optionsByLoc.get(locStr)
  return i === undefined ? null : cfg.data.options[i]!
})

/**
 * Extraction warnings mentioning this option's namespace — the honest answer
 * to "why is this option missing": its chunk may have been degraded or
 * abandoned (options.ts writes "<configId> options.<path>: …", reconcile
 * re-surfaces cached ones with a "[cached] " prefix).
 */
const relatedWarnings = $derived.by(() => {
  const marker = `${configId} options.`
  return (app.manifest?.warnings ?? []).filter((w) => {
    const at = w.indexOf(marker)
    if (at < 0) return false
    const path = w.slice(at + marker.length).split(":")[0]!
    return locStr.startsWith(path) || path.startsWith(locStr)
  })
})

const fileFor = (storePath: string): FileMeta | null =>
  app.manifest && app.flakeIndexes ? resolveFile(storePath, app.manifest, app.flakeIndexes) : null

/**
 * Per-definition priority chip. Definitions carry their own prio only when
 * the module system exposes raw values; the real one merges every surviving
 * definition at the option's highestPrio (see DefinitionRef.prio JSDoc).
 */
const prioChip = (prio: number | undefined): { label: string; cls: string } | null => {
  const p = prio ?? entry?.highestPrio
  if (p === undefined) return null
  if (p === PRIO.mkForce) return { label: "mkForce", cls: "force" }
  if (p === PRIO.mkDefault) return { label: "mkDefault", cls: "soft" }
  if (p === PRIO.optionDefault) return { label: "option default", cls: "od" }
  if (p !== PRIO.plain) return { label: `mkOverride ${p}`, cls: "force" }
  return null
}

const otherConfigs = $derived((app.manifest?.configurations ?? []).filter((c) => c.id !== configId))

/** "customized" | "default" | "not present" for a LOADED sibling config; null when unloaded. */
const presenceIn = (id: string): string | null => {
  const other = loadedConfig(app.configs[id])
  if (!other) return null
  const i = other.indexes.optionsByLoc.get(locStr)
  if (i === undefined) return "not present"
  return other.data.options[i]!.customized ? "customized" : "default"
}
</script>

{#snippet fileLink(meta: FileMeta | null, storePath: string, line?: number)}
  {#if meta}
    <button
      class="link mono"
      onclick={() => app.select({ kind: "module", configId, moduleId: meta.id })}
    >{meta.relPath}{line !== undefined ? `:${line}` : ""}</button>
    {#if meta.origin.kind === "input"}<span class="muted mono">({meta.origin.input})</span>{/if}
  {:else}
    <span class="mono">{storePath}{line !== undefined ? `:${line}` : ""}</span>
  {/if}
{/snippet}

{#snippet valueBlock(value: unknown, valueError: true | undefined, valueSkipped: true | undefined)}
  {#if valueError}
    <p class="err">⚠ value failed to evaluate</p>
  {:else if valueSkipped}
    <p class="muted">(value skipped — package-typed, or from a degraded extraction chunk)</p>
  {:else if value !== undefined}
    <pre class="mono">{#each jsonSegments(value, "") as seg}<span class={seg.cls}>{seg.text}</span>{/each}</pre>
  {:else}
    <p class="muted">—</p>
  {/if}
{/snippet}

<h2 class="mono">{locStr}</h2>
<p class="crumb">
  option in
  <button class="link mono" onclick={() => app.select({ kind: "config", configId })}>{configId}</button>
</p>

{#if !slot || slot === "loading"}
  <p class="muted">Extracting / loading options… (first run can take a minute or two)</p>
{:else if err}
  <p class="err">{err.error}</p>
  {#if !err.permanent}
    <button class="link" onclick={() => app.retryConfig(configId)}>retry</button>
  {/if}
{:else if !entry}
  <p class="muted">Not present in this configuration.</p>
  {#if relatedWarnings.length}
    <ul class="warns">
      {#each relatedWarnings as w}<li class="mono warn">{w}</li>{/each}
    </ul>
  {/if}
{:else}
  <div class="chips">
    {#if entry.type}<span class="type mono">{entry.type}</span>{/if}
    {#if entry.customized && prioChip(undefined)}
      {@const chip = prioChip(undefined)!}
      <span class="chip {chip.cls}">{chip.label}</span>
    {/if}
    {#if entry.readOnly}<span class="chip ro">read-only</span>{/if}
  </div>
  {#if entry.description}<p class="desc">{entry.description}</p>{/if}

  <section>
    <h3>Declared in</h3>
    {#if entry.declarations.length === 0}
      <p class="muted">No declaration recorded (inline or anonymous module).</p>
    {:else}
      <ul class="plain">
        {#each entry.declarations as d (d.file)}
          <li>{@render fileLink(fileFor(d.file), d.file, d.line)}</li>
        {/each}
      </ul>
    {/if}
  </section>

  <section>
    <h3>Default</h3>
    {#if entry.defaultText}
      <pre class="mono">{entry.defaultText}</pre>
    {:else}
      {@render valueBlock(entry.default, undefined, undefined)}
    {/if}
  </section>

  {#if entry.isDefined}
    <section>
      <h3>Definitions <span class="count">{entry.definitions.length}</span></h3>
      <p class="mergenote muted">
        In merge order. The module system only exposes the definitions that survived priority
        filtering — every entry below merged at the winning priority.
      </p>
      <ol class="defs">
        {#each entry.definitions as d, i (`${d.file}#${i}`)}
          <li>
            <div class="defhead">
              {@render fileLink(fileFor(d.file), d.file)}
              {#if prioChip(d.prio)}
                {@const chip = prioChip(d.prio)!}
                <span class="chip {chip.cls}">{chip.label}</span>
              {/if}
            </div>
            {@render valueBlock(d.value, d.valueError, d.valueSkipped)}
          </li>
        {/each}
      </ol>
    </section>

    <section>
      <h3>Final merged value</h3>
      {@render valueBlock(entry.value, entry.valueError, entry.valueSkipped)}
    </section>
  {:else}
    <section>
      <h3>Definitions</h3>
      <p class="muted">Not set anywhere — this configuration uses the default.</p>
    </section>
  {/if}

  {#if otherConfigs.length}
    <section>
      <h3>Other configurations</h3>
      <ul class="plain">
        {#each otherConfigs as c (c.id)}
          <li>
            <button
              class="link mono"
              onclick={() => app.select({ kind: "option", configId: c.id, loc })}
            >{c.id}</button>
            {#if presenceIn(c.id)}<span class="muted">{presenceIn(c.id)}</span>{/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}
{/if}

<style>
  h2 {
    margin: 0;
    font-size: 0.9375rem;
    word-break: break-all;
  }
  .crumb {
    margin: 2px 0 10px;
    font-size: 0.75rem;
    color: var(--ink-muted);
  }
  .mono {
    font-family: ui-monospace, monospace;
  }
  .muted {
    color: var(--ink-muted);
    font-size: 0.8125rem;
  }
  .err {
    color: var(--err);
    font-size: 0.8125rem;
  }
  .warn {
    color: var(--warn);
    font-size: 0.75rem;
  }
  .warns {
    margin: 6px 0 0;
    padding-left: 18px;
  }
  .chips {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 6px;
    flex-wrap: wrap;
  }
  .type {
    color: var(--ink-muted);
    font-size: 0.75rem;
  }
  .chip {
    flex: none;
    font-size: 0.625rem;
    border-radius: 8px;
    padding: 0 6px;
    line-height: 1rem;
  }
  .chip.force {
    background: color-mix(in srgb, var(--err) 18%, transparent);
    color: var(--err);
  }
  .chip.soft {
    background: color-mix(in srgb, var(--warn) 18%, transparent);
    color: var(--warn);
  }
  .chip.ro,
  .chip.od {
    background: var(--page);
    color: var(--ink-muted);
  }
  .desc {
    margin: 4px 0 0;
    font-size: 0.8125rem;
    color: var(--ink-2);
    max-width: 60rem;
  }
  section {
    border-top: 1px solid var(--grid);
    padding-top: 10px;
    margin-top: 12px;
  }
  h3 {
    margin: 0 0 6px;
    font-size: 0.8125rem;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .count {
    color: var(--ink-muted);
    font-weight: normal;
  }
  .mergenote {
    margin: 0 0 6px;
    font-size: 0.75rem;
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
  .defs {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 0.8125rem;
  }
  .defhead {
    display: flex;
    align-items: baseline;
    gap: 8px;
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
  pre {
    background: var(--page);
    border: 1px solid var(--grid);
    border-radius: 6px;
    font-size: 0.75rem;
    margin: 4px 0 0;
    padding: 8px 10px;
    overflow-x: auto;
    max-height: 300px;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .tok-key {
    color: var(--code-property);
  }
  .tok-string {
    color: var(--code-json-string);
  }
  .tok-number {
    color: var(--code-number);
  }
  .tok-atom {
    color: var(--code-keyword);
  }
  p {
    margin: 4px 0;
  }
</style>
