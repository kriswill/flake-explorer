// Global app state (Svelte 5 runes). Big payloads (manifest, config blobs)
// live in $state.raw — immutable snapshots, never deep-proxied. Heavy lookup
// structures (ConfigIndexes) are cached outside reactivity in indexCache and
// swapped in as raw references.

import { SvelteSet } from "svelte/reactivity"
import type { AboutData } from "../../src/licenses"
import type { ConfigData, FileSource, Manifest, OptionEntry, PackageData } from "../../src/schema"
import { parseFileId, SCHEMA_VERSION } from "../../src/schema"
import { registerSlotKeys } from "./color"
import { hasEmbedded, isStatic, loadJson } from "./data"
import { decodeHash, encodeHash, type Filters, type Selection, sameSelection } from "./hash"
import {
  buildConfigIndexes,
  buildFlakeIndexes,
  type ConfigIndexes,
  type FileMeta,
  type FlakeIndexes,
  fileTreeAncestorIds,
  groupKeyOf,
  resolveFile,
} from "./indexes"

/** permanent: the document is simply absent from a static export — a retry
 *  cannot succeed, so components hide the retry button. */
export type SlotError = { error: string; permanent?: true }

export type ConfigSlot = "loading" | SlotError | { data: ConfigData; indexes: ConfigIndexes }

/** Narrow a ConfigSlot to its loaded shape; null while loading/errored/absent. */
export function loadedConfig(
  slot: ConfigSlot | undefined,
): Extract<ConfigSlot, { data: ConfigData }> | null {
  return slot && typeof slot === "object" && "data" in slot ? slot : null
}

/** Error slot of a failed ConfigSlot; null otherwise. */
export function configError(slot: ConfigSlot | undefined): SlotError | null {
  return slot && typeof slot === "object" && "error" in slot ? slot : null
}

export type PackageSlot = "loading" | SlotError | { data: PackageData }

/** Narrow a PackageSlot to its loaded shape; null while loading/errored/absent. */
export function loadedPackage(
  slot: PackageSlot | undefined,
): Extract<PackageSlot, { data: PackageData }> | null {
  return slot && typeof slot === "object" && "data" in slot ? slot : null
}

/** Error slot of a failed PackageSlot; null otherwise. */
export function packageError(slot: PackageSlot | undefined): SlotError | null {
  return slot && typeof slot === "object" && "error" in slot ? slot : null
}

export type FileContentSlot = "loading" | SlotError | FileSource

export type Hover = { kind: "file"; fileId: string } | { kind: "module"; fileId: string } | null

// Persisted UI preferences (theme, font scale, pane widths) live in their
// own module — see prefs.svelte.ts.

class AppState {
  manifest = $state.raw<Manifest | null>(null)
  manifestError = $state<string | null>(null)
  flakeIndexes = $state.raw<FlakeIndexes | null>(null)
  configs = $state.raw<Record<string, ConfigSlot>>({})
  packages = $state.raw<Record<string, PackageSlot>>({})
  fileContents = $state.raw<Record<string, FileContentSlot>>({})

  expanded = new SvelteSet<string>()
  /** Expanded folder nodes in the right file tree. */
  fileExpanded = new SvelteSet<string>()
  selection = $state.raw<Selection | null>(null)
  hover = $state.raw<Hover>(null)
  /** Option tooltip: anchor position + the hovered entry. */
  tip = $state.raw<{ x: number; y: number; entry: OptionEntry } | null>(null)

  aboutOpen = $state(false)
  about = $state.raw<AboutData | null>(null)

  async openAbout() {
    this.aboutOpen = true
    if (!this.about) {
      try {
        this.about = await loadJson<AboutData>("about.json")
      } catch {
        // modal degrades to the static blurb without license texts
      }
    }
  }
  q = $state("")
  showAll = $state(false)

  /** Config whose module tree/details are active (from selection). */
  activeConfigId = $derived(
    this.selection?.kind === "config" ||
      this.selection?.kind === "module" ||
      this.selection?.kind === "option"
      ? this.selection.configId
      : null,
  )

  activeConfig = $derived.by(() => {
    const id = this.activeConfigId
    return loadedConfig(id ? this.configs[id] : undefined)
  })

  /** Tree node ids to tint while hovering a file (file leaf + ancestors). */
  highlightedNodes = $derived.by(() => {
    if (!this.hover || !this.activeConfig) return new Set<string>()
    return this.activeConfig.indexes.fileToNodes.get(this.hover.fileId) ?? new Set<string>()
  })

  /** File ids to tint while a file is selected (its imports + importers). */
  highlightedFiles = $derived.by(() => {
    if (this.selection?.kind !== "file" || !this.flakeIndexes) return new Set<string>()
    const id = this.selection.fileId
    return new Set([
      ...(this.flakeIndexes.imports.get(id) ?? []),
      ...(this.flakeIndexes.importedBy.get(id) ?? []),
    ])
  })

  async loadManifest() {
    this.manifestError = null
    try {
      const m = await loadJson<Manifest>("manifest.json")
      if (m.version !== SCHEMA_VERSION)
        throw new Error(incompatibleData("manifest.json", m.version))
      this.manifest = m
      this.flakeIndexes = buildFlakeIndexes(m)
      registerSlotKeys(
        Object.values(m.inputs)
          .filter((i) => !i.transitive)
          .map((i) => i.name),
      )
      // A deep link decoded before the manifest arrived couldn't load its
      // configuration yet — follow it now.
      this.#followSelection(this.selection)
    } catch (e) {
      this.manifestError = String(e)
    }
  }

  async loadConfig(configId: string) {
    if (!this.manifest || this.configs[configId]) return
    const ref = this.manifest.configurations.find((c) => c.id === configId)
    if (!ref) return
    // Static export without this config's blob: there is no server to
    // extract it on demand, so report that instead of a doomed fetch.
    if (isStatic() && !hasEmbedded(ref.dataFile)) {
      const error =
        ref.status === "error" && ref.error
          ? `extraction failed during export: ${ref.error}`
          : "configuration not included in this export"
      this.configs = { ...this.configs, [configId]: { error, permanent: true } }
      return
    }
    this.configs = { ...this.configs, [configId]: "loading" }
    try {
      const data = await loadJson<ConfigData>(ref.dataFile)
      if (data.version !== SCHEMA_VERSION)
        throw new Error(incompatibleData(ref.dataFile, data.version))
      const indexes = buildConfigIndexes(this.manifest, data, this.flakeIndexes!)
      this.configs = { ...this.configs, [configId]: { data, indexes } }
    } catch (e) {
      this.configs = { ...this.configs, [configId]: { error: String(e) } }
    }
  }

  retryConfig(configId: string) {
    const { [configId]: _, ...rest } = this.configs
    this.configs = rest
    void this.loadConfig(configId)
  }

  /** Same lifecycle as loadConfig above, for a derivation-typed output. */
  async loadPackage(packageId: string) {
    if (!this.manifest || this.packages[packageId]) return
    const ref = this.manifest.packages.find((p) => p.id === packageId)
    if (!ref) return
    if (isStatic() && !hasEmbedded(ref.dataFile)) {
      const error =
        ref.status === "error" && ref.error
          ? `extraction failed during export: ${ref.error}`
          : "package not included in this export"
      this.packages = { ...this.packages, [packageId]: { error, permanent: true } }
      return
    }
    this.packages = { ...this.packages, [packageId]: "loading" }
    try {
      const data = await loadJson<PackageData>(ref.dataFile)
      if (data.version !== SCHEMA_VERSION)
        throw new Error(incompatibleData(ref.dataFile, data.version))
      this.packages = { ...this.packages, [packageId]: { data } }
    } catch (e) {
      this.packages = { ...this.packages, [packageId]: { error: String(e) } }
    }
  }

  retryPackage(packageId: string) {
    const { [packageId]: _, ...rest } = this.packages
    this.packages = rest
    void this.loadPackage(packageId)
  }

  /**
   * storePath is the caller's job to resolve (see FileDetail.svelte): a file
   * reached only through an option's declarations/definitions — e.g. a file
   * inside nixpkgs itself, never walked by the self/import-tree file
   * enumeration — has no entry in manifest.files for an id-only lookup to
   * find server-side.
   */
  async loadFileContent(fileId: string, storePath: string) {
    if (this.fileContents[fileId]) return
    // A static export embeds file sources under the id alone — the store
    // paths it resolved from are meaningless in a browser. Only the dynamic
    // server needs the storePath (as a query param) to read the file.
    const key = `file/${encodeURIComponent(fileId)}`
    if (isStatic() && !hasEmbedded(key)) {
      this.fileContents = {
        ...this.fileContents,
        [fileId]: {
          error: "source not included in this export (re-export with --sources all)",
          permanent: true,
        },
      }
      return
    }
    this.fileContents = { ...this.fileContents, [fileId]: "loading" }
    try {
      const source = await loadJson<FileSource>(
        hasEmbedded(key) ? key : `${key}?storePath=${encodeURIComponent(storePath)}`,
      )
      this.fileContents = { ...this.fileContents, [fileId]: source }
    } catch (e) {
      this.fileContents = { ...this.fileContents, [fileId]: { error: String(e) } }
    }
  }

  retryFileContent(fileId: string, storePath: string) {
    const { [fileId]: _, ...rest } = this.fileContents
    this.fileContents = rest
    void this.loadFileContent(fileId, storePath)
  }

  // ---------------------------------------------------------------- routing

  #applyingHash = false

  select(sel: Selection | null) {
    const filterOnly = sameSelection(this.selection, sel)
    this.selection = sel
    this.#followSelection(sel)
    this.#writeHash(filterOnly)
  }

  /** Load the config behind a selection and reveal its file in the right tree. */
  #followSelection(sel: Selection | null) {
    if (sel?.kind === "config" || sel?.kind === "module") {
      const p = this.loadConfig(sel.configId)
      if (sel.kind === "module") {
        this.revealFile(sel.moduleId)
        void p.then(() => this.revealFile(sel.moduleId))
      }
    } else if (sel?.kind === "option") {
      void this.loadConfig(sel.configId).then(() => this.#revealOptionDeclarer(sel))
    } else if (sel?.kind === "file") {
      this.revealFile(sel.fileId)
    } else if (sel?.kind === "output") {
      // Deep links (#/o/…) land here too — expand the left tree and extract
      // on cold-load, same as clicking down to the leaf would.
      this.revealOutput(sel.path)
      const ref = this.manifest?.packages.find((p) => samePath(p.path, sel.path))
      if (ref) void this.loadPackage(ref.id)
    }
  }

  /** Reveal an option's first declaring file in the right tree (post-load). */
  #revealOptionDeclarer(sel: Extract<Selection, { kind: "option" }>) {
    const loaded = loadedConfig(this.configs[sel.configId])
    if (!loaded || !this.manifest || !this.flakeIndexes) return
    const i = loaded.indexes.optionsByLoc.get(sel.loc.join("."))
    const decl = i === undefined ? undefined : loaded.data.options[i]!.declarations[0]
    if (!decl) return
    this.revealFile(resolveFile(decl.file, this.manifest, this.flakeIndexes).id)
  }

  /**
   * Expand the left outputs-tree ancestor chain leading to an output-tree
   * leaf — mirrors revealFile below, but for the OutputsTree/OutputBranch
   * `out:<dot.joined.path>` keys rather than the file tree's ids. Clicking
   * down through the tree expands each ancestor as you go; a URL-driven
   * selection (deep link, back/forward) needs to do the same in one shot.
   */
  revealOutput(path: string[]) {
    for (let i = 1; i < path.length; i++) this.expanded.add(`out:${path.slice(0, i).join(".")}`)
  }

  /** Expand the right-pane folder chain leading to a file. */
  revealFile(fileId: string) {
    let meta: FileMeta | undefined
    for (const slot of Object.values(this.configs)) {
      const loaded = loadedConfig(slot)
      if (loaded) {
        meta = loaded.indexes.filesById.get(fileId)
        if (meta) break
      }
    }
    if (!meta) {
      // Config not loaded (yet) — the id itself encodes group + path for
      // self/input files; unknown-bucket files need the config lookup above.
      const parsed = parseFileId(fileId)
      if (parsed) {
        meta = {
          id: fileId,
          relPath: parsed.relPath,
          origin:
            parsed.kind === "self" ? { kind: "self" } : { kind: "input", input: parsed.input },
          storePath: "",
        }
      }
    }
    if (!meta) return
    const groupKey = groupKeyOf(meta.origin)
    if (!groupKey) return
    for (const id of fileTreeAncestorIds(groupKey, meta.relPath)) this.fileExpanded.add(id)
  }

  setFilters(f: Partial<Filters>) {
    if (f.q !== undefined) this.q = f.q
    if (f.all !== undefined) this.showAll = f.all
    this.#writeHash(true)
  }

  #writeHash(replace: boolean) {
    if (this.#applyingHash || typeof window === "undefined") return
    const hash = `#${encodeHash({ sel: this.selection, filters: { q: this.q, all: this.showAll } })}`
    if (window.location.hash === hash) return
    if (replace) window.history.replaceState(null, "", hash)
    else window.history.pushState(null, "", hash)
  }

  applyHash(raw: string) {
    this.#applyingHash = true
    try {
      const view = decodeHash(raw)
      this.selection = view.sel
      this.q = view.filters.q
      this.showAll = view.filters.all
      this.#followSelection(view.sel)
    } finally {
      this.#applyingHash = false
    }
  }

  initRouting() {
    if (typeof window === "undefined") return
    this.applyHash(window.location.hash)
    window.addEventListener("hashchange", () => this.applyHash(window.location.hash))
  }
}

/** Both data documents carry SCHEMA_VERSION — surface drift as a clear "re-extract" message. */
const incompatibleData = (name: string, got: unknown) =>
  `${name} was produced by an incompatible extractor (schema v${got ?? "pre-1"}, this UI expects v${SCHEMA_VERSION}) — re-run extract`

const samePath = (a: string[], b: string[]) =>
  a.length === b.length && a.every((s, i) => s === b[i])

export const app = new AppState()
