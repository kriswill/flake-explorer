<script lang="ts">
  import { app } from "../lib/state.svelte";
  import { colorFor } from "../lib/color";
  import { THEMES } from "../lib/themes";
  import type { FileMeta } from "../lib/indexes";

  const gen = $derived(THEMES[app.themeIndex]!.gen);

  interface Group {
    key: string;
    label: string;
    colorKey: string;
    files: { id: string; relPath: string; colorKey: string }[];
  }

  const groups = $derived.by((): Group[] => {
    if (!app.manifest) return [];
    const q = app.q.toLowerCase();
    const match = (p: string) => q === "" || p.toLowerCase().includes(q);

    const self: Group = {
      key: "self",
      label: app.manifest.flake.ref,
      colorKey: "self",
      files: app.manifest.files
        .filter((f) => match(f.relPath))
        .map((f) => ({ id: f.id, relPath: f.relPath, colorKey: f.id })),
    };

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
    const inputs = [...inputFiles.entries()]
      .sort(([a], [b]) => (a === "nixpkgs" ? 1 : b === "nixpkgs" ? -1 : a.localeCompare(b)))
      .map(([input, metas]) => ({
        key: `input:${input}`,
        label: input,
        colorKey: input,
        files: metas
          .filter((m) => match(m.relPath))
          .sort((a, b) => a.relPath.localeCompare(b.relPath))
          .map((m) => ({ id: m.id, relPath: m.relPath, colorKey: input })),
      }));

    return [self, ...inputs].filter((g) => g.files.length > 0);
  });

  const splitPath = (p: string): [string, string] => {
    const i = p.lastIndexOf("/");
    return i < 0 ? ["", p] : [p.slice(0, i + 1), p.slice(i + 1)];
  };
</script>

<div class="files">
  {#each groups as group (group.key)}
    <div class="ghead" style="--c:{colorFor(group.colorKey, gen)}">
      <span class="dot"></span>
      <span class="glabel mono">{group.label}</span>
      <span class="count">{group.files.length}</span>
    </div>
    <ul>
      {#each group.files as f (f.id)}
        {@const [dir, base] = splitPath(f.relPath)}
        <li>
          <button
            class="row"
            class:sel={app.selection?.kind === "file" && app.selection.fileId === f.id}
            class:rel={app.highlightedFiles.has(f.id)}
            class:hov={app.hover?.kind === "module" && app.hover.fileId === f.id}
            style="--c:{colorFor(f.colorKey, gen)}"
            onclick={() => app.select({ kind: "file", fileId: f.id })}
            onpointerenter={() => (app.hover = { kind: "file", fileId: f.id })}
            onpointerleave={() => (app.hover = null)}
          >
            <span class="dot"></span>
            <span class="path mono"><span class="dir">{dir}</span>{base}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/each}
</div>

<style>
  .files {
    padding: 8px 6px;
  }
  .ghead {
    position: sticky;
    top: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--surface-1);
    padding: 6px;
    border-bottom: 1px solid var(--grid);
    z-index: 1;
  }
  .glabel {
    font-size: 12px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .count {
    margin-left: auto;
    color: var(--ink-muted);
    font-size: 11px;
  }
  ul {
    list-style: none;
    margin: 0 0 10px;
    padding: 0;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    background: none;
    border: none;
    border-radius: 6px;
    color: var(--ink-1);
    font: inherit;
    padding: 2px 6px;
    cursor: pointer;
    text-align: left;
  }
  .row:hover,
  .row.hov {
    background: color-mix(in srgb, var(--c) 14%, transparent);
  }
  .row.rel {
    background: color-mix(in srgb, var(--c) 22%, transparent);
  }
  .row.sel {
    background: var(--page);
    box-shadow: inset 2px 0 0 var(--c);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--c);
    flex: none;
  }
  .path {
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
  }
  .dir {
    color: var(--ink-muted);
  }
  .mono {
    font-family: ui-monospace, monospace;
  }
</style>
