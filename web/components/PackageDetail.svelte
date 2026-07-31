<script lang="ts">
import { colorFor } from "../lib/color"
import { hasEmbedded, isStatic } from "../lib/data"
import { humanBytes } from "../lib/graph-annotations"
import { parsePosition, resolveFile } from "../lib/indexes"
import { prefs } from "../lib/prefs.svelte"
import { segmentLines } from "../lib/segments"
import { app, loadedGraph, loadedPackage } from "../lib/state.svelte"
import { webUrl } from "../lib/url"
import AsyncSlot from "./AsyncSlot.svelte"
import Dot from "./Dot.svelte"
import GraphExpand from "./GraphExpand.svelte"
import GraphLegend from "./GraphLegend.svelte"
import HeaderChip from "./HeaderChip.svelte"
import SourceView from "./SourceView.svelte"

interface Props {
  refId: string
}
const { refId }: Props = $props()

const ref = $derived(app.manifest?.packages.find((p) => p.id === refId) ?? null)
const slot = $derived(app.packages[refId])
const loaded = $derived(loadedPackage(slot))
const data = $derived(loaded?.data ?? null)

const colorKey = $derived(ref?.path[0] ?? refId)
const title = $derived(data?.pname ?? data?.name ?? ref?.path.at(-1) ?? refId)

/** Non-package categories get a role badge — "check"/"dev shell"/"formatter". */
const ROLES: Record<string, string> = {
  checks: "check",
  devShells: "dev shell",
  formatter: "formatter",
}
const roleBadge = $derived(ROLES[ref?.path[0] ?? ""] ?? null)

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

/** meta.position is "file:line" — only a clickable chip when it's under the flake's own path. */
const positionInfo = $derived.by(() => {
  const position = data?.meta?.position
  if (!position || !app.manifest || !app.flakeIndexes) return null
  const { file, line } = parsePosition(position)
  if (!file.startsWith(`${app.manifest.flake.path}/`)) return { file, line, fileId: null }
  const meta = resolveFile(file, app.manifest, app.flakeIndexes)
  return { file, line, fileId: meta.id }
})

/**
 * "Depended on by": packages in this flake that depend on THIS one, joined on
 * drv.drvPath (the only sound key — reverse-deps.ts). A static export embeds an
 * authoritative index; serve mode has none, so derive over packages loaded this
 * session (blind to unloaded ones — hence the honest "among loaded" label and
 * the load-the-rest affordance).
 */
const reverseDeps = $derived.by(() => {
  const idx = app.manifest?.packageReverseDeps
  if (idx) return { ids: idx[refId] ?? [], scope: "static" as const }
  const myDrv = data?.drv?.drvPath
  if (!myDrv) return { ids: [] as string[], scope: "loaded" as const }
  const ids: string[] = []
  for (const p of app.manifest?.packages ?? []) {
    if (p.id === refId) continue
    const dep = loadedPackage(app.packages[p.id])
    if (dep?.data.drv?.inputDrvs.some((i) => i.drvPath === myDrv)) ids.push(p.id)
  }
  return { ids: ids.sort(), scope: "loaded" as const }
})

/** Packages not yet loaded — the client-side join above cannot see these. */
const unloadedPackages = $derived((app.manifest?.packages ?? []).filter((p) => !app.packages[p.id]))

/**
 * A static export downgrades non-embedded packages to "pending" (export.ts);
 * with none pending, the embedded index covers the whole flake and "in this
 * flake" is exact. A partial `--packages a,b` export leaves the rest pending —
 * the index then can't see an un-exported dependent, so the label must not
 * claim flake-wide truth. (Errored packages have no drv → never a dependent →
 * don't count against completeness.)
 */
const staticComplete = $derived((app.manifest?.packages ?? []).every((p) => p.status !== "pending"))

const scopeNote = $derived(
  reverseDeps.scope === "loaded"
    ? "among loaded packages"
    : staticComplete
      ? "in this flake"
      : "among exported packages",
)
const emptyNote = $derived(
  reverseDeps.scope === "loaded"
    ? "No dependents among loaded packages."
    : staticComplete
      ? "No other package in this flake depends on it."
      : "No exported package depends on it.",
)

/** id → path, built once — the revdeps list would otherwise scan every render. */
const pkgPathById = $derived(
  new Map((app.manifest?.packages ?? []).map((p) => [p.id, p.path] as const)),
)
const pkgLabel = (id: string) => pkgPathById.get(id)?.at(-1) ?? id

function loadAllPackages() {
  for (const p of app.manifest?.packages ?? []) void app.loadPackage(p.id)
}

/**
 * The dependency graph for THIS output, if the export has one. Graph ids reuse
 * the package id space, but the two refs are looked up independently and their
 * statuses genuinely differ in real manifests (a devShell whose graph is `ok`
 * while its package is still `pending`), so neither may be inferred from the
 * other. `manifest.graphs` is optional — a manifest from an extractor that
 * predates graphs simply has no such key.
 */
const graphRef = $derived(app.manifest?.graphs?.find((g) => g.id === refId) ?? null)
const graphSlot = $derived(graphRef ? app.graphs[refId] : undefined)
const graph = $derived(loadedGraph(graphSlot))

/**
 * This package's own node, joined on drvPath — the only sound key. Names
 * collide hard (only 10,165 of 18,765 are distinct on a system graph), so a
 * name or basename match would pick a plausible wrong node. Measured on real
 * data, a package's `drv.drvPath` IS its graph's root node, and the graph's
 * depth-1 is exactly the `inputDrvs` list already rendered above — but the
 * join is done rather than assumed, and `undefined` is a state we say out loud.
 */
const myNode = $derived(
  graph && data?.drv ? graph.indexes.byDrvPath.get(data.drv.drvPath) : undefined,
)

/**
 * Dependents WITHIN the loaded graph. For this package's own node this is
 * always empty and always will be: a GraphData rooted at X is X's dependency
 * closure, so X is a source — measured 0 on all three real documents. The
 * empty case therefore gets a sentence naming the reason, never a bare 0 next
 * to the flake-scoped count, which a reader would take as "nothing depends on
 * this package" — a much stronger and false claim.
 */
const graphDependents = $derived(
  graph && myNode !== undefined
    ? graph.indexes.revOffsets[myNode + 1]! - graph.indexes.revOffsets[myNode]!
    : 0,
)
const isGraphRoot = $derived(graph !== null && myNode === graph.data.root)
</script>

{#if !ref}
  <p class="muted">Unknown package.</p>
{:else}
<AsyncSlot
  value={slot}
  loadingText="Evaluating package… (first run takes a few seconds)"
  retry={() => app.retryPackage(refId)}
>
{#if data}
  <div class="head" style="--c:{colorFor(colorKey, prefs.gen)}">
    <Dot />
    <h2 class="mono">{title}</h2>
    {#if roleBadge}<span class="badge builder">{roleBadge}</span>{/if}
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
    <!-- Rendered only until the graph rows below supersede it: the graph's
         depth-1 is exactly this drvPath set (measured on real data), rendered
         richer — so once a loaded graph joins, this list would repeat every
         row. It stays whenever it is the only dependency information: no
         graph, a loading/errored slot, or a join miss. What the richer rows do
         not carry is which OUTPUT of each input this derivation consumes —
         that detail lives here and in the drv itself. -->
    {#if data.drv?.inputDrvs.length && !(graph && myNode !== undefined)}
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
    {#if graphRef}
      {#if !graphSlot}
        {#if isStatic() && !hasEmbedded(graphRef.dataFile)}
          <!-- Static export without this graph embedded: loading can never
               succeed, so say that instead of offering a dead button. -->
          <p class="muted">graph not included in this export</p>
        {:else}
          <button class="loadall" onclick={() => app.loadGraph(refId)}>
            load the full dependency graph{isStatic() ? "" : " (may extract)"}
          </button>
        {/if}
      {:else}
        <AsyncSlot
          value={graphSlot}
          loadingText="Extracting dependency graph… (first run takes a while)"
          retry={() => app.retryGraph(refId)}
        >
          {#snippet children(g)}
            <!-- "full dependency graph" already names the boundary; the rows'
                 counts carry their scope in each expander's accessible name.
                 A separate right-floating scope label was the counts' column
                 heading before they moved into the leading gutter. -->
            <div class="graph-note">
              <span class="k">full dependency graph</span>
            </div>
            {#if myNode === undefined}
              <!-- Said out loud rather than rendered as an empty tree: an
                   absent join is a fact about the documents, not "no deps". -->
              <p class="muted">
                This derivation is not present in this graph — nothing to expand.
              </p>
            {:else}
              <GraphLegend data={g.data} />
              <div class="graph-rows">
                <GraphExpand data={g.data} indexes={g.indexes} anchor={myNode} dir="deps" graphId={refId} />
              </div>
            {/if}
          {/snippet}
        </AsyncSlot>
      {/if}
    {/if}
  </section>

  <section>
    <h3>
      Depended on by <span class="count">{reverseDeps.ids.length}</span>
      <span class="scope">{scopeNote}</span>
    </h3>
    {#if reverseDeps.ids.length}
      <ul class="revdeps">
        {#each reverseDeps.ids as id (id)}
          {@const path = pkgPathById.get(id)}
          <li>
            {#if path}
              <button class="link mono" onclick={() => app.select({ kind: "output", path })}>{pkgLabel(id)}</button>
            {:else}
              <span class="mono">{id}</span>
            {/if}
          </li>
        {/each}
      </ul>
    {:else}
      <p class="muted">{emptyNote}</p>
    {/if}
    <!-- Only a drvPath join is sound, so this sees the flake's OWN packages
         only — a nixpkgs consumer of this derivation never appears. In serve
         mode the join is further limited to loaded packages; offer to load the
         rest so the count can complete. -->
    {#if reverseDeps.scope === "loaded" && unloadedPackages.length}
      <button class="loadall" onclick={loadAllPackages}>
        load {unloadedPackages.length} more package{unloadedPackages.length === 1 ? "" : "s"} to complete (may extract)
      </button>
    {/if}
    <!-- A SECOND, separately labelled answer — never merged into the count
         above. "Within this graph" and "in this flake" are different questions
         and a reader must be able to tell which one they are reading. -->
    {#if graph && myNode !== undefined}
      <div class="graph-revdeps">
        {#if isGraphRoot}
          <p class="muted">
            This derivation is the root of its own dependency graph — nothing in this graph
            depends on it. A graph rooted here contains what it needs, not what needs it.
          </p>
        {:else}
          <div class="graph-note">
            <span class="k">graph dependents</span>
            <span class="count">{graphDependents}</span>
            <span class="scope">within this graph</span>
          </div>
          <div class="graph-rows">
            <GraphExpand
              data={graph.data}
              indexes={graph.indexes}
              anchor={myNode}
              dir="dependents"
              graphId={refId}
            />
          </div>
        {/if}
      </div>
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
    font-size: var(--text-sm);
    word-break: break-all;
  }
  .path {
    margin: 0 0 8px;
    font-size: var(--text-2xs);
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
    font-size: var(--text-2xs);
  }
  .sep {
    color: var(--ink-muted);
  }
  .badge {
    background: var(--page);
    color: var(--ink-muted);
    border-radius: 8px;
    padding: 1px 8px;
    font-size: var(--text-3xs);
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
    font-size: var(--text-xs);
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
    font-size: var(--text-xs);
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
    font-size: var(--text-xs);
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
    font-size: var(--text-xs);
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
    font-size: var(--text-2xs);
  }
  .outs li,
  .drvs li,
  .refs li {
    padding: 2px 0;
    word-break: break-all;
  }
  .scope {
    color: var(--ink-muted);
    font-weight: normal;
    font-size: var(--text-3xs);
    margin-left: auto;
  }
  .revdeps {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: var(--text-xs);
  }
  .link {
    background: none;
    border: none;
    padding: 0;
    color: var(--link);
    font-size: var(--text-xs);
    cursor: pointer;
    text-align: left;
    word-break: break-all;
  }
  .link:hover {
    text-decoration: underline;
  }
  .loadall {
    margin-top: 6px;
    background: none;
    border: 1px solid var(--grid);
    border-radius: 6px;
    color: var(--ink-2);
    font-size: var(--text-2xs);
    padding: 3px 8px;
    cursor: pointer;
  }
  .loadall:hover {
    color: var(--link);
    border-color: var(--link);
  }
  /* Graph-backed sections. No colour of their own: the scope label and the
     count reuse the same tokens the flake-scoped section already uses, so the
     two answers look like siblings — which is what they are. */
  .graph-note {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 10px 0 4px;
    font-size: var(--text-2xs);
  }
  .graph-rows {
    margin-left: 2px;
  }
  .graph-revdeps {
    margin-top: 10px;
    border-top: 1px solid var(--grid);
    padding-top: 6px;
  }
</style>
