<script lang="ts">
import { colorFor } from "../lib/color"
import { parsePosition, resolveFile } from "../lib/indexes"
import { prefs } from "../lib/prefs.svelte"
import { segmentLines } from "../lib/segments"
import { app, loadedPackage } from "../lib/state.svelte"
import { THEMES } from "../lib/themes"
import { webUrl } from "../lib/url"
import AsyncSlot from "./AsyncSlot.svelte"
import Dot from "./Dot.svelte"
import HeaderChip from "./HeaderChip.svelte"
import SourceView from "./SourceView.svelte"

interface Props {
  refId: string
}
const { refId }: Props = $props()

const gen = $derived(THEMES[prefs.themeIndex]!.gen)
const ref = $derived(app.manifest?.packages.find((p) => p.id === refId) ?? null)
const slot = $derived(app.packages[refId])
const loaded = $derived(loadedPackage(slot))
const data = $derived(loaded?.data ?? null)

const colorKey = $derived(ref?.path[0] ?? refId)
const title = $derived(data?.pname ?? data?.name ?? ref?.path.at(-1) ?? refId)

const depGroups = $derived(
  data
    ? ([
        { label: "nativeBuildInputs", items: data.deps.nativeBuildInputs },
        { label: "buildInputs", items: data.deps.buildInputs },
        { label: "propagatedBuildInputs", items: data.deps.propagatedBuildInputs },
      ] as const)
    : [],
)

const spdxUrl = (spdxId: string) => `https://spdx.org/licenses/${spdxId}.html`

function humanBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"]
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${i > 0 && v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

/** meta.position is "file:line" — only a clickable chip when it's under the flake's own path. */
const positionInfo = $derived.by(() => {
  const position = data?.meta?.position
  if (!position || !app.manifest || !app.flakeIndexes) return null
  const { file, line } = parsePosition(position)
  if (!file.startsWith(`${app.manifest.flake.path}/`)) return { file, line, fileId: null }
  const meta = resolveFile(file, app.manifest, app.flakeIndexes)
  return { file, line, fileId: meta.id }
})
</script>

{#if !ref}
  <p class="muted">Unknown package.</p>
{:else}
<AsyncSlot
  value={slot}
  loadingText="Evaluating package… (first run takes a few seconds)"
  retry={() => app.retryPackage(refId)}
>
{#snippet children()}
{#if data}
  <div class="head" style="--c:{colorFor(colorKey, gen)}">
    <Dot />
    <h2 class="mono">{title}</h2>
    <span class="badge builder">{data.builder}</span>
    {#if positionInfo?.fileId}
      {@const fileId = positionInfo.fileId}
      <HeaderChip label="file" onclick={() => app.select({ kind: "file", fileId })}>
        {#snippet icon()}
          <!-- source file: a page with a folded corner -->
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
            <path
              d="M4 1.5h5l3 3v9.5H4z M9 1.5v3h3"
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
  <p class="path mono muted">{ref.path.join(".")}</p>

  <section>
    <h3>Summary</h3>
    <dl>
      {#if data.pname}<dt>pname</dt><dd class="mono">{data.pname}</dd>{/if}
      {#if data.pkgVersion}<dt>version</dt><dd class="mono">{data.pkgVersion}</dd>{/if}
      {#if data.stdenv}<dt>stdenv</dt><dd class="mono">{data.stdenv}</dd>{/if}
      {#if data.system}<dt>system</dt><dd class="mono">{data.system}</dd>{/if}
    </dl>
    {#if data.meta?.description}<p>{data.meta.description}</p>{/if}
  </section>

  {#if data.meta}
    <section>
      <h3>Metadata</h3>
      <dl>
        {#if data.meta.license?.length}
          <dt>license</dt>
          <dd>
            {#each data.meta.license as lic, i (i)}
              {#if i > 0}<span class="sep">, </span>{/if}
              {#if lic.spdxId}
                <a class="urltag mono" href={spdxUrl(lic.spdxId)} target="_blank" rel="noopener"
                  >{lic.spdxId}</a
                >
              {:else}
                <span class="mono">{lic.shortName ?? lic.fullName ?? "unknown"}</span>
              {/if}
            {/each}
          </dd>
        {/if}
        {#if data.meta.homepage}
          <dt>homepage</dt>
          <dd>
            {#if webUrl(data.meta.homepage)}
              <a class="urltag mono" href={data.meta.homepage} target="_blank" rel="noopener"
                >{data.meta.homepage}</a
              >
            {:else}
              <span class="mono">{data.meta.homepage}</span>
            {/if}
          </dd>
        {/if}
        {#if data.meta.mainProgram}
          <dt>mainProgram</dt>
          <dd class="mono">{data.meta.mainProgram}</dd>
        {/if}
        {#if data.meta.platforms?.length}
          <dt>platforms</dt>
          <dd>
            <details>
              <summary>{data.meta.platforms.length} platforms</summary>
              <p class="mono">{data.meta.platforms.join(", ")}</p>
            </details>
          </dd>
        {/if}
        {#if data.meta.maintainers?.length}
          <dt>maintainers</dt>
          <dd>{data.meta.maintainers.map((m) => m.name ?? m.github ?? m.email ?? "?").join(", ")}</dd>
        {/if}
        {#if positionInfo}
          <dt>position</dt>
          <dd class="mono">{positionInfo.file}{positionInfo.line ? `:${positionInfo.line}` : ""}</dd>
        {/if}
        {#if data.meta.broken}
          <dt>broken</dt>
          <dd class="err">true</dd>
        {/if}
        {#if data.meta.unfree}
          <dt>unfree</dt>
          <dd>true</dd>
        {/if}
      </dl>
    </section>
  {/if}

  {#if data.src}
    <section>
      <h3>Source</h3>
      <dl>
        {#if data.src.url}<dt>url</dt><dd class="mono">{data.src.url}</dd>{/if}
        {#if data.src.rev}<dt>rev</dt><dd class="mono">{data.src.rev}</dd>{/if}
        {#if data.src.outputHash}<dt>outputHash</dt><dd class="mono">{data.src.outputHash}</dd>{/if}
        {#if data.src.storePath}<dt>storePath</dt><dd class="mono">{data.src.storePath}</dd>{/if}
      </dl>
    </section>
  {/if}

  {#if data.drv}
    {@const drv = data.drv}
    <section>
      <h3>Build</h3>
      <dl>
        <dt>builder</dt>
        <dd class="mono">{drv.builderPath}</dd>
        {#if drv.doCheck !== undefined}<dt>doCheck</dt><dd>{drv.doCheck}</dd>{/if}
        {#if drv.strictDeps !== undefined}<dt>strictDeps</dt><dd>{drv.strictDeps}</dd>{/if}
        {#if drv.structuredAttrs !== undefined}
          <dt>structuredAttrs</dt>
          <dd>{drv.structuredAttrs}</dd>
        {/if}
      </dl>
      {#if drv.phases.length}
        {#each drv.phases as phase (phase.name)}
          <details>
            <summary class="mono">{phase.name}</summary>
            <div class="phase-src">
              <SourceView lines={segmentLines(phase.script, phase.tokens)} />
            </div>
          </details>
        {/each}
      {:else}
        <p class="muted">No phase scripts recorded (trivial builder, or structuredAttrs).</p>
      {/if}
    </section>
  {/if}

  <section>
    <h3>Dependencies</h3>
    {#each depGroups as g (g.label)}
      {#if g.items.length}
        <p><span class="k">{g.label}</span> <span class="mono">{g.items.join(", ")}</span></p>
      {/if}
    {/each}
    {#if depGroups.every((g) => g.items.length === 0)}
      <p class="muted">No declared build inputs.</p>
    {/if}
    {#if data.drv?.inputDrvs.length}
      <details>
        <summary>{data.drv.inputDrvs.length} drv-level inputs</summary>
        <ul class="drvs">
          {#each data.drv.inputDrvs as input (input.drvPath)}
            <li class="mono" title={input.drvPath}
              >{input.name} <span class="muted">({input.outputs.join(", ")})</span></li
            >
          {/each}
        </ul>
      </details>
    {/if}
  </section>

  <section>
    <h3>Outputs <span class="count">{data.outputs.length}</span></h3>
    <ul class="outs">
      {#each data.outputs as out (out.name)}
        <li class="mono">
          <span class="k">{out.name}</span>
          {#if out.outPath}
            {out.outPath}
            {#if data.runtime?.[out.name]}<span class="badge instore">in store</span>{/if}
          {/if}
        </li>
      {/each}
    </ul>
  </section>

  {#if data.runtime && Object.keys(data.runtime).length}
    <section>
      <h3>Runtime closure</h3>
      {#each Object.entries(data.runtime) as [outName, info] (outName)}
        <p class="mono">
          <span class="k">{outName}</span>
          {#if info.narSize !== undefined}narSize {humanBytes(info.narSize)}{/if}
          {#if info.closureSize !== undefined}<span class="sep"> · </span>closureSize {humanBytes(
              info.closureSize,
            )}{/if}
        </p>
        <details>
          <summary>{info.references.length} references</summary>
          <ul class="refs">
            {#each info.references as r (r)}<li class="mono">{r.split("/").pop()}</li>{/each}
          </ul>
        </details>
      {/each}
    </section>
  {/if}

  {#if data.warnings.length}
    <details>
      <summary>{data.warnings.length} extraction warnings</summary>
      <ul>
        {#each data.warnings as w}<li class="mono warn">{w}</li>{/each}
      </ul>
    </details>
  {/if}
{/if}
{/snippet}
</AsyncSlot>
{/if}

<style>
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 2px;
  }
  h2 {
    margin: 0;
    font-size: 0.9375rem;
    word-break: break-all;
  }
  .path {
    margin: 0 0 8px;
    font-size: 0.75rem;
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
  .sep {
    color: var(--ink-muted);
  }
  .badge {
    background: var(--page);
    color: var(--ink-muted);
    border-radius: 8px;
    padding: 1px 8px;
    font-size: 0.6875rem;
    flex: none;
  }
  .badge.builder {
    margin-left: auto;
    color: var(--c);
    background: color-mix(in srgb, var(--c) 12%, var(--page));
  }
  .badge.instore {
    margin-left: 6px;
    color: var(--ok, var(--ink-2));
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
  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 3px 10px;
    margin: 0;
    font-size: 0.8125rem;
  }
  dt {
    color: var(--ink-muted);
  }
  dd {
    margin: 0;
    word-break: break-all;
  }
  p {
    margin: 4px 0;
    font-size: 0.8125rem;
  }
  .k {
    color: var(--ink-muted);
    margin-right: 6px;
  }
  .urltag {
    color: var(--ink-2);
    text-decoration: none;
    border-bottom: 1px solid transparent;
  }
  .urltag:hover {
    color: var(--c);
    border-color: color-mix(in srgb, var(--c) 60%, transparent);
  }
  details {
    margin-top: 6px;
    font-size: 0.8125rem;
  }
  details summary {
    cursor: pointer;
    color: var(--ink-2);
  }
  .phase-src {
    max-height: 260px;
    overflow: auto;
    background: var(--page);
    border: 1px solid var(--grid);
    border-radius: 6px;
    padding: 8px;
  }
  .outs,
  .drvs,
  .refs {
    list-style: none;
    margin: 4px 0 0;
    padding: 0;
    font-size: 0.75rem;
  }
  .outs li,
  .drvs li,
  .refs li {
    padding: 2px 0;
    word-break: break-all;
  }
</style>
