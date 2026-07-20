<script lang="ts">
import { colorFor } from "../lib/color"
import { buildFileTree, type FileMeta, type FileTreeNode, fileTreeMatches } from "../lib/indexes"
import { prefs } from "../lib/prefs.svelte"
import { app, loadedConfig } from "../lib/state.svelte"
import { THEMES } from "../lib/themes"
import Dot from "./Dot.svelte"
import FileTreeBranch from "./FileTreeBranch.svelte"

const gen = $derived(THEMES[prefs.themeIndex]!.gen)

interface Group {
  key: string
  label: string
  colorKey: string
  tree: FileTreeNode
  count: number
}

/**
 * Files any loaded configuration actually uses. The input groups below are
 * built from exactly this set already; only the self group lists everything,
 * so the contributing-only toggle is really "trim the self group".
 */
const contributingIds = $derived.by(() => {
  const ids = new Set<string>()
  for (const s of Object.values(app.configs)) {
    const slot = loadedConfig(s)
    if (slot) for (const id of slot.indexes.filesById.keys()) ids.add(id)
  }
  return ids
})

const anyConfigLoaded = $derived(contributingIds.size > 0)

const groups = $derived.by((): Group[] => {
  if (!app.manifest) return []

  const selfFiles = app.manifest.files
    .filter((f) => !app.contribOnly || !anyConfigLoaded || contributingIds.has(f.id))
    .map((f) => ({
      id: f.id,
      relPath: f.relPath,
      colorKey: f.id,
    }))

  // Input files appear once a configuration referencing them is loaded.
  const inputFiles = new Map<string, FileMeta[]>()
  for (const s of Object.values(app.configs)) {
    const slot = loadedConfig(s)
    if (!slot) continue
    for (const meta of slot.indexes.filesById.values()) {
      const key =
        meta.origin.kind === "input"
          ? meta.origin.input
          : meta.origin.kind === "unknown" && meta.origin.group
            ? meta.origin.group
            : null
      if (!key) continue
      const list = inputFiles.get(key) ?? []
      if (!list.some((m) => m.id === meta.id)) list.push(meta)
      inputFiles.set(key, list)
    }
  }

  const all: Group[] = [
    {
      key: "self",
      label: app.manifest.flake.ref,
      colorKey: "self",
      tree: buildFileTree(selfFiles, "self"),
      count: selfFiles.length,
    },
    ...[...inputFiles.entries()]
      .sort(([a], [b]) => (a === "nixpkgs" ? 1 : b === "nixpkgs" ? -1 : a.localeCompare(b)))
      .map(([input, metas]) => ({
        key: `input:${input}`,
        label: input,
        colorKey: input,
        tree: buildFileTree(
          metas.map((m) => ({ id: m.id, relPath: m.relPath, colorKey: input })),
          `input:${input}`,
        ),
        count: metas.length,
      })),
  ]
  return all
})

/** A group hides entirely when the filter matches nothing inside it. */
const visibleGroups = $derived(groups.filter((g) => fileTreeMatches(g.tree, app.q.toLowerCase())))
</script>

<div class="files">
  <label class="contrib" class:off={!anyConfigLoaded}>
    <input
      type="checkbox"
      checked={app.contribOnly}
      disabled={!anyConfigLoaded}
      onchange={(e) => app.setFilters({ contrib: e.currentTarget.checked })}
    />
    only contributing files
    {#if !anyConfigLoaded}<span class="hint">— load a configuration first</span>{/if}
  </label>

  {#each visibleGroups as group (group.key)}
    <section class="group" style="--c:{colorFor(group.colorKey, gen)}">
      <div class="ghead">
        <Dot />
        <span class="glabel mono">{group.label}</span>
        <span class="count">{group.count}</span>
      </div>
      <div class="gbody">
        <FileTreeBranch node={group.tree} depth={0} />
      </div>
    </section>
  {/each}
</div>

<style>
  .files {
    padding: 8px;
  }
  .contrib {
    display: flex;
    align-items: center;
    gap: 5px;
    margin: 0 0 8px 2px;
    font-size: 0.6875rem;
    color: var(--ink-2);
    cursor: pointer;
  }
  .contrib.off {
    color: var(--ink-muted);
    cursor: default;
  }
  .hint {
    color: var(--ink-muted);
  }
  .group {
    border: 1px solid color-mix(in srgb, var(--c) 30%, var(--grid));
    border-radius: 10px;
    margin-bottom: 12px;
    /* no overflow:hidden — it would break the sticky header */
  }
  .ghead {
    position: sticky;
    top: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    background: color-mix(in srgb, var(--c) 12%, var(--surface-1));
    padding: 6px 8px;
    border-bottom: 1px solid color-mix(in srgb, var(--c) 30%, var(--grid));
    border-radius: 9px 9px 0 0;
    /* Above FileTreeBranch's .row (z-index: 2) so scrolled rows tuck behind
       the sticky header instead of painting over it. */
    z-index: 3;
  }
  .gbody {
    padding: 4px 4px 6px;
  }
  .glabel {
    font-size: 0.75rem;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .count {
    margin-left: auto;
    color: var(--ink-muted);
    font-size: 0.6875rem;
  }
  .mono {
    font-family: ui-monospace, monospace;
  }
</style>
