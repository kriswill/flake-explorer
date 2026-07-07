<script lang="ts">
  import Dot from "./Dot.svelte";
  import { app } from "../lib/state.svelte";
  import { colorFor } from "../lib/color";
  import { THEMES } from "../lib/themes";
  import { buildFileTree, type FileMeta, type FileTreeNode } from "../lib/indexes";
  import FileTreeBranch from "./FileTreeBranch.svelte";

  const gen = $derived(THEMES[app.themeIndex]!.gen);

  interface Group {
    key: string;
    label: string;
    colorKey: string;
    tree: FileTreeNode;
    count: number;
  }

  const groups = $derived.by((): Group[] => {
    if (!app.manifest) return [];

    const selfFiles = app.manifest.files.map((f) => ({ id: f.id, relPath: f.relPath, colorKey: f.id }));

    // Input files appear once a configuration referencing them is loaded.
    const inputFiles = new Map<string, FileMeta[]>();
    for (const slot of Object.values(app.configs)) {
      if (typeof slot !== "object" || !("indexes" in slot)) continue;
      for (const meta of slot.indexes.filesById.values()) {
        const key =
          meta.origin.kind === "input"
            ? meta.origin.input
            : meta.origin.kind === "unknown" && meta.origin.group
              ? meta.origin.group
              : null;
        if (!key) continue;
        const list = inputFiles.get(key) ?? [];
        if (!list.some((m) => m.id === meta.id)) list.push(meta);
        inputFiles.set(key, list);
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
    ];
    return all;
  });

  /** A group hides entirely when the filter matches nothing inside it. */
  function hasMatch(n: FileTreeNode, q: string): boolean {
    if (q === "") return true;
    if (n.fileId) return n.path.toLowerCase().includes(q);
    return n.children.some((c) => hasMatch(c, q));
  }
  const visibleGroups = $derived(groups.filter((g) => hasMatch(g.tree, app.q.toLowerCase())));
</script>

<div class="files">
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
    z-index: 1;
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
