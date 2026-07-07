// Global app state (Svelte 5 runes). Big payloads (manifest, config blobs)
// live in $state.raw — immutable snapshots, never deep-proxied. Heavy lookup
// structures (ConfigIndexes) are cached outside reactivity in indexCache and
// swapped in as raw references.

import { SvelteSet } from "svelte/reactivity";
import type { ConfigData, Manifest, OptionEntry } from "../../src/schema";
import { loadJson } from "./data";
import { decodeHash, encodeHash, sameSelection, type Filters, type Selection } from "./hash";
import {
  buildConfigIndexes,
  buildFlakeIndexes,
  fileTreeAncestorIds,
  groupKeyOf,
  type ConfigIndexes,
  type FileMeta,
  type FlakeIndexes,
} from "./indexes";
import { registerSlotKeys } from "./color";

export type ConfigSlot = "loading" | { error: string } | { data: ConfigData; indexes: ConfigIndexes };

export type Hover = { kind: "file"; fileId: string } | { kind: "module"; fileId: string } | null;

class AppState {
  themeIndex = $state(0);
  manifest = $state.raw<Manifest | null>(null);
  manifestError = $state<string | null>(null);
  flakeIndexes = $state.raw<FlakeIndexes | null>(null);
  configs = $state.raw<Record<string, ConfigSlot>>({});

  expanded = new SvelteSet<string>();
  /** Expanded folder nodes in the right file tree. */
  fileExpanded = new SvelteSet<string>();
  selection = $state.raw<Selection | null>(null);
  hover = $state.raw<Hover>(null);
  /** Option tooltip: anchor position + the hovered entry. */
  tip = $state.raw<{ x: number; y: number; entry: OptionEntry } | null>(null);
  q = $state("");
  showAll = $state(false);

  /** Config whose module tree/details are active (from selection). */
  activeConfigId = $derived(
    this.selection?.kind === "config" || this.selection?.kind === "module" ? this.selection.configId : null,
  );

  activeConfig = $derived.by(() => {
    const id = this.activeConfigId;
    const slot = id ? this.configs[id] : undefined;
    return slot && typeof slot === "object" && "data" in slot ? slot : null;
  });

  /** Tree node ids to tint while hovering a file (file leaf + ancestors). */
  highlightedNodes = $derived.by(() => {
    if (!this.hover || !this.activeConfig) return new Set<string>();
    return this.activeConfig.indexes.fileToNodes.get(this.hover.fileId) ?? new Set<string>();
  });

  /** File ids to tint while a file is selected (its imports + importers). */
  highlightedFiles = $derived.by(() => {
    if (this.selection?.kind !== "file" || !this.flakeIndexes) return new Set<string>();
    const id = this.selection.fileId;
    return new Set([...(this.flakeIndexes.imports.get(id) ?? []), ...(this.flakeIndexes.importedBy.get(id) ?? [])]);
  });

  async loadManifest() {
    this.manifestError = null;
    try {
      const m = await loadJson<Manifest>("manifest.json");
      this.manifest = m;
      this.flakeIndexes = buildFlakeIndexes(m);
      registerSlotKeys(
        Object.values(m.inputs)
          .filter((i) => !i.transitive)
          .map((i) => i.name),
      );
      // A deep link decoded before the manifest arrived couldn't load its
      // configuration yet — follow it now.
      this.#followSelection(this.selection);
    } catch (e) {
      this.manifestError = String(e);
    }
  }

  async loadConfig(configId: string) {
    if (!this.manifest || this.configs[configId]) return;
    const ref = this.manifest.configurations.find((c) => c.id === configId);
    if (!ref) return;
    this.configs = { ...this.configs, [configId]: "loading" };
    try {
      const data = await loadJson<ConfigData>(ref.dataFile);
      const indexes = buildConfigIndexes(this.manifest, data, this.flakeIndexes!);
      this.configs = { ...this.configs, [configId]: { data, indexes } };
    } catch (e) {
      this.configs = { ...this.configs, [configId]: { error: String(e) } };
    }
  }

  retryConfig(configId: string) {
    const { [configId]: _, ...rest } = this.configs;
    this.configs = rest;
    void this.loadConfig(configId);
  }

  // ---------------------------------------------------------------- routing

  #applyingHash = false;

  select(sel: Selection | null) {
    const filterOnly = sameSelection(this.selection, sel);
    this.selection = sel;
    this.#followSelection(sel);
    this.#writeHash(filterOnly);
  }

  /** Load the config behind a selection and reveal its file in the right tree. */
  #followSelection(sel: Selection | null) {
    if (sel?.kind === "config" || sel?.kind === "module") {
      const p = this.loadConfig(sel.configId);
      if (sel.kind === "module") {
        this.revealFile(sel.moduleId);
        void p.then(() => this.revealFile(sel.moduleId));
      }
    } else if (sel?.kind === "file") {
      this.revealFile(sel.fileId);
    }
  }

  /** Expand the right-pane folder chain leading to a file. */
  revealFile(fileId: string) {
    let meta: FileMeta | undefined;
    for (const slot of Object.values(this.configs)) {
      if (typeof slot === "object" && "indexes" in slot) {
        meta = slot.indexes.filesById.get(fileId);
        if (meta) break;
      }
    }
    if (!meta) {
      // Config not loaded (yet) — the id itself encodes group + path for
      // self/input files; unknown-bucket files need the config lookup above.
      if (fileId.startsWith("self:")) {
        meta = { id: fileId, relPath: fileId.slice(5), origin: { kind: "self" }, storePath: "" };
      } else {
        const m = fileId.match(/^input:([^:]+):(.+)$/);
        if (m) meta = { id: fileId, relPath: m[2]!, origin: { kind: "input", input: m[1]! }, storePath: "" };
      }
    }
    if (!meta) return;
    const groupKey = groupKeyOf(meta.origin);
    if (!groupKey) return;
    for (const id of fileTreeAncestorIds(groupKey, meta.relPath)) this.fileExpanded.add(id);
  }

  setFilters(f: Partial<Filters>) {
    if (f.q !== undefined) this.q = f.q;
    if (f.all !== undefined) this.showAll = f.all;
    this.#writeHash(true);
  }

  #writeHash(replace: boolean) {
    if (this.#applyingHash || typeof window === "undefined") return;
    const hash = "#" + encodeHash({ sel: this.selection, filters: { q: this.q, all: this.showAll } });
    if (window.location.hash === hash) return;
    if (replace) window.history.replaceState(null, "", hash);
    else window.history.pushState(null, "", hash);
  }

  applyHash(raw: string) {
    this.#applyingHash = true;
    try {
      const view = decodeHash(raw);
      this.selection = view.sel;
      this.q = view.filters.q;
      this.showAll = view.filters.all;
      this.#followSelection(view.sel);
    } finally {
      this.#applyingHash = false;
    }
  }

  initRouting() {
    if (typeof window === "undefined") return;
    this.applyHash(window.location.hash);
    window.addEventListener("hashchange", () => this.applyHash(window.location.hash));
  }
}

export const app = new AppState();
