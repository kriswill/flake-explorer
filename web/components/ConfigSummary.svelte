<!-- Configuration landing page. The review's "empty center states squander
     the stage": this used to be a one-line count plus an instruction to go
     click something. Everything here is already client-side (the tree's
     rolled-up customized counts, filesById, refsByFile) — it just needed
     drawing. -->
<script lang="ts">
import { inputNameOf, type TreeNode } from "../lib/indexes"
import { app, loadedConfig } from "../lib/state.svelte"

const { configId }: { configId: string } = $props()

const cfg = $derived(loadedConfig(app.configs[configId]))

const stats = $derived.by(() => {
  if (!cfg) return null
  const opts = cfg.data.options
  return {
    total: opts.length,
    customized: opts.filter((o) => o.customized).length,
    files: cfg.indexes.filesById.size,
  }
})

/**
 * Where the customization actually lives: the highest-count nodes near the
 * top of the tree (sortAndSum already rolled child counts into parents), one
 * level deep per branch so a busy directory doesn't crowd out its siblings.
 */
const hotspots = $derived.by(() => {
  if (!cfg) return []
  const out: { node: TreeNode; input: string | null }[] = []
  for (const top of cfg.indexes.tree.children) {
    if (top.customized === 0) continue
    const input = inputNameOf(top.id)
    // Group roots (self dirs / input roots) contribute their busiest child;
    // a file at the top level stands for itself.
    const pick = top.children.length
      ? [...top.children].sort((a, b) => b.customized - a.customized)[0]!
      : top
    out.push({ node: pick.customized > 0 ? pick : top, input })
  }
  return out.sort((a, b) => b.node.customized - a.node.customized).slice(0, 6)
})

/** Which inputs this configuration draws modules from, by file count. */
const inputUsage = $derived.by(() => {
  if (!cfg) return []
  const counts = new Map<string, number>()
  for (const meta of cfg.indexes.filesById.values()) {
    const key =
      meta.origin.kind === "input"
        ? meta.origin.input
        : meta.origin.kind === "unknown" && meta.origin.group
          ? meta.origin.group
          : null
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
})

const siblings = $derived((app.manifest?.configurations ?? []).filter((c) => c.id !== configId))

/** Selecting a hotspot: file leaves open their module page, dirs just reveal. */
function goto(node: TreeNode) {
  if (node.fileId) app.select({ kind: "module", configId, moduleId: node.fileId })
  else app.expanded.add(node.id)
}
</script>

<h2 class="mono">{configId}</h2>

{#if stats}
  <p>
    {stats.total} options, {stats.customized} customized, {stats.files} contributing files.
  </p>

  {#if hotspots.length}
    <section>
      <h3>Most customized areas</h3>
      <ul class="plain">
        {#each hotspots as h (h.node.id)}
          <li>
            <button class="link mono" onclick={() => goto(h.node)}>{h.node.label}</button>
            <span class="muted">{h.node.customized} set</span>
            {#if h.input}<span class="muted mono">({h.input})</span>{/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if inputUsage.length}
    <section>
      <h3>Modules by input</h3>
      <ul class="plain">
        {#each inputUsage as [input, count] (input)}
          <li>
            <button class="link mono" onclick={() => app.select({ kind: "input", name: input })}>{input}</button>
            <span class="muted">{count} files</span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if siblings.length}
    <section>
      <h3>Compare with</h3>
      <ul class="plain">
        {#each siblings as s (s.id)}
          <li>
            <button
              class="link mono"
              onclick={() => app.select({ kind: "diff", a: configId, b: s.id })}
            >{s.id}</button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
{/if}

<style>
  h2 {
    margin: 0 0 8px;
    font-size: var(--text-md);
  }
  .mono {
    font-family: ui-monospace, monospace;
  }
  .muted {
    color: var(--ink-muted);
    font-size: var(--text-2xs);
  }
  p {
    margin: 4px 0;
    font-size: var(--text-xs);
  }
  section {
    border-top: 1px solid var(--grid);
    padding-top: 10px;
    margin-top: 12px;
  }
  h3 {
    margin: 0 0 6px;
    font-size: var(--text-xs);
  }
  .plain {
    list-style: none;
    margin: 0;
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
</style>
