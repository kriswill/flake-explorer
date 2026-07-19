<script lang="ts">
import { REL_PATH_RE, resolveKnownRef } from "../../src/pathref"
import { displayLabel, type FileOrigin } from "../../src/schema"
import { colorFor } from "../lib/color"
import { resolveFile } from "../lib/indexes"
import { type Interval, segmentLines } from "../lib/segments"
import { app, loadedConfig, loadedPackage } from "../lib/state.svelte"
import { THEMES } from "../lib/themes"
import Dot from "./Dot.svelte"
import HeaderChip from "./HeaderChip.svelte"
import InputProvenance from "./InputProvenance.svelte"
import SourceView from "./SourceView.svelte"

const { fileId }: { fileId: string } = $props()

const gen = $derived(THEMES[app.themeIndex]!.gen)
const manifestEntry = $derived(app.manifest?.files.find((f) => f.id === fileId) ?? null)

/** Config-side view of this file (any loaded config that references it). */
const configView = $derived.by(() => {
  for (const [configId, s] of Object.entries(app.configs)) {
    const slot = loadedConfig(s)
    if (!slot) continue
    const meta = slot.indexes.filesById.get(fileId)
    if (meta) return { configId, slot, meta, refs: slot.indexes.refsByFile.get(fileId)! }
  }
  return null
})

const relPath = $derived(manifestEntry?.relPath ?? configView?.meta.relPath ?? fileId)
const inputName = $derived.by(() => {
  const origin = manifestEntry?.origin ?? configView?.meta.origin
  return origin?.kind === "input" ? origin.input : null
})
const inputInfo = $derived(inputName ? (app.manifest?.inputs[inputName] ?? null) : null)
const colorKey = $derived(inputName ?? fileId)

const imports = $derived([...(app.flakeIndexes?.imports.get(fileId) ?? [])])
const importedBy = $derived([...(app.flakeIndexes?.importedBy.get(fileId) ?? [])])

// ------------------------------------------------------------- source view

const origin = $derived(manifestEntry?.origin ?? configView?.meta.origin ?? null)
const storePath = $derived(manifestEntry?.storePath ?? configView?.meta.storePath ?? null)
const contentSlot = $derived(app.fileContents[fileId])

/** The module system reports some declarations under a relative pseudo-path
 *  (nixpkgs declares _module.* as literally "lib/modules.nix") — there is no
 *  store file behind those, so don't ask the server for one. */
const virtualPath = $derived(storePath !== null && !storePath.startsWith("/"))

/** manifestEntry only covers self + import-tree files; configView.meta also resolves
 *  option-only files (e.g. inside nixpkgs itself) — either way, wait for a real storePath. */
$effect(() => {
  if (storePath && !virtualPath) app.loadFileContent(fileId, storePath)
})

const sameOrigin = (a: FileOrigin, b: FileOrigin): boolean => {
  if (a.kind !== b.kind) return false
  if (a.kind === "input" && b.kind === "input") return a.input === b.input
  if (a.kind === "unknown" && b.kind === "unknown") return a.group === b.group
  return true
}

/** relPaths this file can address with a "./"/"../" reference: files in the same origin tree. */
const siblingIndex = $derived.by(() => {
  const known = new Set<string>()
  const byRelPath = new Map<string, string>()
  if (origin) {
    for (const f of app.manifest?.files ?? []) {
      if (sameOrigin(f.origin, origin)) {
        known.add(f.relPath)
        byRelPath.set(f.relPath, f.id)
      }
    }
  }
  return { known, byRelPath }
})

/** Resolvable "./"/"../" file references in one line — segmentLines unions
 *  these with the highlight runs so a path literal is colored AND clickable. */
const refsForLine = (line: string): Interval<string | undefined>[] => {
  const refs: Interval<string | undefined>[] = []
  for (const m of line.matchAll(REL_PATH_RE)) {
    const idx = m.index ?? 0
    const target = resolveKnownRef(relPath, m[0], siblingIndex.known)
    refs.push({
      start: idx,
      end: idx + m[0].length,
      value: target ? siblingIndex.byRelPath.get(target) : undefined,
    })
  }
  return refs
}

const lines = $derived.by(() => {
  if (!contentSlot || typeof contentSlot !== "object" || !("text" in contentSlot)) return []
  return segmentLines(contentSlot.text, contentSlot.tokens, refsForLine)
})

/** Options this file customizes, grouped per loaded config. */
const customizes = $derived.by(() => {
  if (!configView) return []
  return configView.refs.defines.map((i) => configView.slot.data.options[i]!)
})

/** Packages (already loaded this session) whose meta.position is this file —
 *  mirrors PackageDetail's positionInfo, which only resolves a chip for
 *  positions under the flake's own path, so only self-authored files land here. */
const packagesHere = $derived.by(() => {
  if (!app.manifest || !app.flakeIndexes) return []
  const selfPrefix = `${app.manifest.flake.path}/`
  const out: { id: string; path: string[]; line?: string }[] = []
  for (const ref of app.manifest.packages) {
    const loaded = loadedPackage(app.packages[ref.id])
    const position = loaded?.data.meta?.position
    if (!position?.startsWith(selfPrefix)) continue
    const m = position.match(/^(.*):(\d+)$/)
    const file = m ? m[1]! : position
    const line = m ? m[2] : undefined
    if (resolveFile(file, app.manifest, app.flakeIndexes).id === fileId) {
      out.push({ id: ref.id, path: ref.path, line })
    }
  }
  return out
})

let copied = $state(false)
async function copyHash() {
  if (!manifestEntry?.git) return
  await navigator.clipboard.writeText(manifestEntry.git.commit)
  copied = true
  setTimeout(() => (copied = false), 1200)
}

const label = displayLabel
</script>

<div class="file-detail">
  <div class="fd-head">
    <div class="head" style="--c:{colorFor(colorKey, gen)}">
      <Dot />
      <h2 class="mono">{relPath}</h2>
      {#if configView}
        <HeaderChip
          label="module"
          onclick={() => app.select({ kind: "module", configId: configView.configId, moduleId: fileId })}
        >
          {#snippet icon()}
            <!-- puzzle piece: a config module is one interlocking piece of the whole -->
            <svg viewBox="0 0 362.125 362.126" width="14" height="14" aria-hidden="true" focusable="false">
              <path
                fill="currentColor"
                d="M329.278,242.223l-18.053,0.024c-3.188,0.004-6.243,1.301-8.459,3.592c-5.436,5.634-12.708,8.742-20.479,8.757 c-15.736,0.015-28.568-12.774-28.592-28.519c0-15.754,12.78-28.559,28.489-28.586c7.781-0.02,15.066,3.064,20.518,8.666 c2.223,2.277,5.271,3.568,8.454,3.562l18.048-0.021c3.126-0.005,6.121-1.25,8.323-3.462c2.202-2.211,3.442-5.202,3.442-8.321 c0,0,0-0.004,0-0.017l-0.146-94.278c-0.004-3.127-1.25-6.121-3.461-8.324c-2.213-2.207-5.211-3.445-8.337-3.441L225.62,92.017 H203.88L203.859,80.9v-0.035c0-4.48,1.823-8.771,5.042-11.9c7.844-7.602,12.162-17.768,12.162-28.617v-0.227 c-0.031-22.074-17.948-40.02-40-40.121c-22.052,0.102-39.969,18.047-40,40.121v0.227c0,10.85,4.318,21.016,12.162,28.617 c3.219,3.129,5.042,7.42,5.042,11.9V80.9l-0.021,11.117h-21.74L33.1,91.855c-3.126-0.004-6.124,1.234-8.337,3.441 c-2.211,2.203-3.457,5.197-3.461,8.324l-0.144,94.278c0,0.013,0,0.017,0,0.017c0,3.119,1.24,6.11,3.442,8.321 c2.202,2.212,5.197,3.457,8.323,3.462l18.048,0.021c3.184,0.011,6.233-1.28,8.454-3.562c5.45-5.602,12.736-8.686,20.518-8.666 c15.709,0.028,28.489,12.832,28.489,28.586c-0.021,15.741-12.854,28.53-28.592,28.519c-7.77-0.015-15.045-3.123-20.478-8.757 c-2.216-2.291-5.271-3.588-8.459-3.592l-18.053-0.024c-6.502-0.007-11.781,5.252-11.789,11.757l0.122,96.268 c0,0.006,0,0.012,0,0.018c0,6.496,5.258,11.769,11.756,11.777l120.108,0.084c3.127,0.004,6.126-1.229,8.338-3.436 c2.212-2.203,3.459-5.197,3.463-8.32l0.019-9.994c0-0.006,0-0.01,0-0.022c0-3.185-1.296-6.232-3.583-8.455 c-5.572-5.398-8.64-12.623-8.64-20.33v-0.159c0.022-15.686,12.752-28.434,28.417-28.505c15.665,0.071,28.395,12.819,28.417,28.505 v0.159c0,7.707-3.067,14.932-8.64,20.33c-2.287,2.223-3.584,5.271-3.584,8.455c0,0.014,0,0.018,0,0.022l0.02,9.994 c0.004,3.123,1.251,6.117,3.463,8.32c2.212,2.207,5.211,3.438,8.338,3.436l120.108-0.084c6.498-0.01,11.756-5.281,11.756-11.777 c0-0.006,0-0.012,0-0.018l0.126-96.268C341.059,247.475,335.78,242.216,329.278,242.223z"
              />
            </svg>
          {/snippet}
        </HeaderChip>
      {/if}
      {#if packagesHere.length === 1}
        {@const pkg = packagesHere[0]!}
        <HeaderChip label="package" onclick={() => app.select({ kind: "output", path: pkg.path })}>
          {#snippet icon()}
            <!-- open box: this file is the source position of a package/derivation -->
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
              <path
                d="M8 1.5 14 5v6L8 14.5 2 11V5z M2 5l6 3 6-3 M8 8v6.5"
                fill="none"
                stroke="currentColor"
                stroke-width="1.2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          {/snippet}
        </HeaderChip>
      {/if}
    </div>

    {#if inputInfo}
      <InputProvenance input={inputInfo} />
    {/if}

    <!-- Input-origin files skip this: InputProvenance above already shows the
         locked rev, and repeating it as a section was pure noise. -->
    {#if manifestEntry?.git}
      <div class="section">
        <h3>last commit</h3>
        <p class="mono commit">
          {manifestEntry.git.commit}
          <button class="copy" onclick={copyHash}>{copied ? "copied" : "copy"}</button>
        </p>
        <p class="muted">{manifestEntry.git.date.slice(0, 19).replace("T", " ")} — {manifestEntry.git.subject}</p>
      </div>
    {/if}
  </div>

  <div class="fd-body">
    {#if virtualPath}
      <p class="muted">
        The module system reports this declaration under the virtual path
        <span class="mono">{storePath}</span> — there is no store file to show.
      </p>
    {:else if !contentSlot || contentSlot === "loading"}
      <p class="muted">loading source…</p>
    {:else if "error" in contentSlot}
      <p class="muted err">
        {contentSlot.error.split("\n")[0]}
        {#if !contentSlot.permanent}
          <button class="retry" onclick={() => app.retryFileContent(fileId, storePath!)}>retry</button>
        {/if}
      </p>
    {:else}
      <SourceView {lines} onref={(id) => app.select({ kind: "file", fileId: id })} />
    {/if}
  </div>

  <div class="fd-foot">
    {#if imports.length || importedBy.length}
      <div class="section">
        {#if importedBy.length}
          <h3>imported by <span class="count">{importedBy.length}</span></h3>
          <ul>
            {#each importedBy as id (id)}
              <li><button class="link mono" onclick={() => app.select({ kind: "file", fileId: id })}>{label(id)}</button></li>
            {/each}
          </ul>
        {/if}
        {#if imports.length}
          <h3>imports <span class="count">{imports.length}</span></h3>
          <ul>
            {#each imports as id (id)}
              <li><button class="link mono" onclick={() => app.select({ kind: "file", fileId: id })}>{label(id)}</button></li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}

    {#if packagesHere.length}
      <div class="section">
        <h3>packages defined here <span class="count">{packagesHere.length}</span></h3>
        <ul>
          {#each packagesHere as p (p.id)}
            <li>
              <button class="link mono" onclick={() => app.select({ kind: "output", path: p.path })}
                >{p.path.join(".")}{p.line ? `:${p.line}` : ""}</button
              >
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if configView}
      <div class="section">
        <h3>customizes in {configView.configId} <span class="count">{customizes.length}</span></h3>
        {#if customizes.length === 0}
          <p class="muted">No customized option values from this file.</p>
        {:else}
          <ul>
            {#each customizes.slice(0, 50) as o (o.loc.join("."))}
              <li>
                <button
                  class="link mono"
                  onclick={() => app.select({ kind: "module", configId: configView.configId, moduleId: fileId })}
                >{o.loc.join(".")}</button>
              </li>
            {/each}
            {#if customizes.length > 50}<li class="muted">… and {customizes.length - 50} more</li>{/if}
          </ul>
        {/if}
      </div>
    {:else}
      <p class="muted section">Load a configuration on the left to see which options this file affects.</p>
    {/if}
  </div>
</div>

<style>
  .file-detail {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .fd-head {
    flex: none;
  }
  .fd-body {
    flex: 1 1 0%;
    min-height: 120px;
    overflow-y: auto;
    border-top: 1px solid var(--grid);
    padding-top: 10px;
    margin-top: 10px;
  }
  /* Capped rather than flex:none — with 100+ "imported by" entries this would
     otherwise take its full natural height and squash .fd-body to its floor. */
  .fd-foot {
    flex: 0 1 auto;
    min-height: 0;
    max-height: 33%;
    overflow-y: auto;
    border-top: 1px solid var(--grid);
    padding-top: 10px;
    margin-top: 10px;
  }
  /* The border already lives on .fd-foot itself so it stays put as that box
     scrolls — without this, .section's own border-top (its first child)
     would scroll away with the content instead of staying pinned. */
  .fd-foot > .section:first-child {
    border-top: none;
    padding-top: 0;
    margin-top: 0;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  h2 {
    margin: 0;
    font-size: 0.9375rem;
    word-break: break-all;
  }
  .section {
    border-top: 1px solid var(--grid);
    padding-top: 10px;
    margin-top: 10px;
  }
  h3 {
    margin: 6px 0;
    font-size: 0.8125rem;
  }
  .count {
    color: var(--ink-muted);
    font-weight: normal;
  }
  .mono {
    font-family: ui-monospace, monospace;
  }
  .commit {
    font-size: 0.8125rem;
    word-break: break-all;
    margin: 2px 0;
  }
  .copy {
    background: var(--page);
    border: 1px solid var(--grid);
    border-radius: 4px;
    color: var(--ink-2);
    font-size: 0.6875rem;
    cursor: pointer;
    margin-left: 6px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    font-size: 0.75rem;
  }
  .link {
    background: none;
    border: none;
    color: var(--link);
    cursor: pointer;
    font-size: 0.75rem;
    padding: 1px 0;
    text-align: left;
    word-break: break-all;
  }
  .muted {
    color: var(--ink-muted);
    font-size: 0.75rem;
  }
  .err {
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
  p {
    margin: 3px 0;
    font-size: 0.8125rem;
  }
</style>
