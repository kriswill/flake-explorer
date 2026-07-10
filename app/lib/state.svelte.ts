// Global app state (Svelte 5 runes). Big payloads (manifest, config blobs)
// live in $state.raw — immutable snapshots, never deep-proxied. Heavy lookup
// structures (ConfigIndexes) are cached outside reactivity in indexCache and
// swapped in as raw references.

import { SvelteSet } from "svelte/reactivity";
import type { AboutData } from "../../src/licenses";
import type { ConfigData, FileSource, Manifest, OptionEntry } from "../../src/schema";
import { parseFileId, SCHEMA_VERSION } from "../../src/schema";
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
import { applyThemeVars, defaultThemeIndex, THEMES } from "./themes";

export type ConfigSlot = "loading" | { error: string } | { data: ConfigData; indexes: ConfigIndexes };

/** Narrow a ConfigSlot to its loaded shape; null while loading/errored/absent. */
export function loadedConfig(slot: ConfigSlot | undefined): Extract<ConfigSlot, { data: ConfigData }> | null {
  return slot && typeof slot === "object" && "data" in slot ? slot : null;
}

/** Error text of a failed ConfigSlot; null otherwise. */
export function configError(slot: ConfigSlot | undefined): string | null {
  return slot && typeof slot === "object" && "error" in slot ? slot.error : null;
}

export type FileContentSlot = "loading" | { error: string } | FileSource;

export type Hover = { kind: "file"; fileId: string } | { kind: "module"; fileId: string } | null;

// Baseline root font-size at 100%. 22.4px = the old 16px base at 140%,
// rebased so the comfortable reading size reads as "100%". The storage key
// is versioned: values saved against the 16px base would render wrong.
const FONT_BASE_PX = 22.4;
const FONT_SCALE_KEY = "flake-explorer:font-scale@2";
const FONT_SCALE_MIN = 0.5;
const FONT_SCALE_MAX = 1.5;

const THEME_KEY = "flake-explorer:theme@1";

class AppState {
  themeIndex = $state(0);
  /** Text scale factor; all component type is rem-based, so root font-size scales everything. */
  fontScale = $state(1);
  manifest = $state.raw<Manifest | null>(null);
  manifestError = $state<string | null>(null);
  flakeIndexes = $state.raw<FlakeIndexes | null>(null);
  configs = $state.raw<Record<string, ConfigSlot>>({});
  fileContents = $state.raw<Record<string, FileContentSlot>>({});

  expanded = new SvelteSet<string>();
  /** Expanded folder nodes in the right file tree. */
  fileExpanded = new SvelteSet<string>();
  selection = $state.raw<Selection | null>(null);
  hover = $state.raw<Hover>(null);
  /** Option tooltip: anchor position + the hovered entry. */
  tip = $state.raw<{ x: number; y: number; entry: OptionEntry } | null>(null);

  aboutOpen = $state(false);
  about = $state.raw<AboutData | null>(null);

  async openAbout() {
    this.aboutOpen = true;
    if (!this.about) {
      try {
        this.about = await loadJson<AboutData>("about.json");
      } catch {
        // modal degrades to the static blurb without license texts
      }
    }
  }
  q = $state("");
  showAll = $state(false);

  /** Config whose module tree/details are active (from selection). */
  activeConfigId = $derived(
    this.selection?.kind === "config" || this.selection?.kind === "module" ? this.selection.configId : null,
  );

  activeConfig = $derived.by(() => {
    const id = this.activeConfigId;
    return loadedConfig(id ? this.configs[id] : undefined);
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
      if (m.version !== SCHEMA_VERSION) throw new Error(incompatibleData("manifest.json", m.version));
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
      if (data.version !== SCHEMA_VERSION) throw new Error(incompatibleData(ref.dataFile, data.version));
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

  /**
   * storePath is the caller's job to resolve (see FileDetail.svelte): a file
   * reached only through an option's declarations/definitions — e.g. a file
   * inside nixpkgs itself, never walked by the self/import-tree file
   * enumeration — has no entry in manifest.files for an id-only lookup to
   * find server-side.
   */
  async loadFileContent(fileId: string, storePath: string) {
    if (this.fileContents[fileId]) return;
    this.fileContents = { ...this.fileContents, [fileId]: "loading" };
    try {
      const source = await loadJson<FileSource>(`file/${encodeURIComponent(fileId)}?storePath=${encodeURIComponent(storePath)}`);
      this.fileContents = { ...this.fileContents, [fileId]: source };
    } catch (e) {
      this.fileContents = { ...this.fileContents, [fileId]: { error: String(e) } };
    }
  }

  retryFileContent(fileId: string, storePath: string) {
    const { [fileId]: _, ...rest } = this.fileContents;
    this.fileContents = rest;
    void this.loadFileContent(fileId, storePath);
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
      const loaded = loadedConfig(slot);
      if (loaded) {
        meta = loaded.indexes.filesById.get(fileId);
        if (meta) break;
      }
    }
    if (!meta) {
      // Config not loaded (yet) — the id itself encodes group + path for
      // self/input files; unknown-bucket files need the config lookup above.
      const parsed = parseFileId(fileId);
      if (parsed) {
        meta = {
          id: fileId,
          relPath: parsed.relPath,
          origin: parsed.kind === "self" ? { kind: "self" } : { kind: "input", input: parsed.input },
          storePath: "",
        };
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

  // ------------------------------------------------------------------ theme

  /** Restore the saved theme; fall back to the OS preference on first visit. */
  initTheme(prefersDark: boolean) {
    const saved = typeof localStorage === "undefined" ? null : localStorage.getItem(THEME_KEY);
    const i = saved === null ? Number.NaN : Number(saved);
    this.setTheme(Number.isInteger(i) && i >= 0 && i < THEMES.length ? i : defaultThemeIndex(prefersDark));
  }

  /** Single write path for the theme: state + persisted choice + CSS vars stay in sync. */
  setTheme(i: number) {
    if (!THEMES[i]) return;
    this.themeIndex = i;
    if (typeof localStorage !== "undefined") localStorage.setItem(THEME_KEY, String(i));
    applyThemeVars(i);
  }

  // ------------------------------------------------------------- font scale

  initFontScale() {
    if (typeof localStorage === "undefined") return;
    const saved = Number(localStorage.getItem(FONT_SCALE_KEY));
    this.setFontScale(Number.isFinite(saved) && saved > 0 ? saved : 1);
  }

  setFontScale(scale: number) {
    this.fontScale = Math.round(Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, scale)) * 100) / 100;
    if (typeof localStorage !== "undefined") localStorage.setItem(FONT_SCALE_KEY, String(this.fontScale));
    if (typeof document !== "undefined") {
      document.documentElement.style.fontSize = `${FONT_BASE_PX * this.fontScale}px`;
    }
  }

  adjustFontScale(delta: number) {
    this.setFontScale(this.fontScale + delta);
  }

  // ------------------------------------------------------------ pane widths

  paneLeft = $state(PANE_DEFAULTS.left);
  paneRight = $state(PANE_DEFAULTS.right);

  initPanes() {
    if (typeof localStorage === "undefined") return;
    try {
      const saved = JSON.parse(localStorage.getItem(PANE_KEY) ?? "{}") as { left?: number; right?: number };
      if (Number.isFinite(saved.left)) this.setPane("left", saved.left!);
      if (Number.isFinite(saved.right)) this.setPane("right", saved.right!);
    } catch {
      // corrupt value — keep defaults
    }
  }

  setPane(side: "left" | "right", px: number) {
    const { min, max } = PANE_LIMITS[side];
    const clamped = Math.round(Math.min(max, Math.max(min, px)));
    if (side === "left") this.paneLeft = clamped;
    else this.paneRight = clamped;
  }

  /** Called at drag end / after keyboard resize — not per pointermove. */
  savePanes() {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(PANE_KEY, JSON.stringify({ left: this.paneLeft, right: this.paneRight }));
  }

  resetPanes() {
    this.paneLeft = PANE_DEFAULTS.left;
    this.paneRight = PANE_DEFAULTS.right;
    this.savePanes();
  }
}

/** Both data documents carry SCHEMA_VERSION — surface drift as a clear "re-extract" message. */
const incompatibleData = (name: string, got: unknown) =>
  `${name} was produced by an incompatible extractor (schema v${got ?? "pre-1"}, this UI expects v${SCHEMA_VERSION}) — re-run extract`;

const PANE_KEY = "flake-explorer:panes@1";
const PANE_DEFAULTS = { left: 280, right: 340 };
const PANE_LIMITS = {
  left: { min: 160, max: 640 },
  right: { min: 200, max: 720 },
} as const;

export const app = new AppState();
