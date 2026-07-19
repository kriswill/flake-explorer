// Pure data-shaping for the SPA: file identity resolution, the left-pane
// module tree, and the O(1) lookup maps behind hover cross-highlighting.
// Built once per (manifest, config) load and cached OUTSIDE runes state —
// these are big, immutable structures.

import type {
  ConfigData,
  FileEntry,
  FileOptionRefs,
  FileOrigin,
  InputInfo,
  Manifest,
} from "../../src/schema"
import { makeFileId, UNKNOWN_FILE } from "../../src/schema"

export interface FileMeta {
  id: string
  relPath: string
  origin: FileOrigin
  storePath: string
  git?: FileEntry["git"]
}

export interface TreeNode {
  id: string // "dir:self:modules/hosts" | fileId | "input:darwin" | "inline"
  label: string
  fileId?: string // set on file leaves
  children: TreeNode[]
  /** Subtree totals for badges. */
  customized: number
  declares: number
}

export interface ConfigIndexes {
  tree: TreeNode
  /** fileId -> tree node ids to highlight (the file's leaf + all ancestors). */
  fileToNodes: Map<string, Set<string>>
  /** fileId -> option refs into config.options (defines = customized only). */
  refsByFile: Map<string, FileOptionRefs>
  /** Every file participating in this config, by id. */
  filesById: Map<string, FileMeta>
  /** loc.join(".") -> index into config.options, for option-page routing. */
  optionsByLoc: Map<string, number>
  /** Lowercased dotted locs, parallel to config.options — the search corpus. */
  optionLocsLower: string[]
}

export interface FlakeIndexes {
  selfByStorePath: Map<string, FileEntry>
  /** Input storePath prefixes, longest first, for origin attribution. */
  inputPrefixes: { prefix: string; input: string }[]
  /** Store basename ("w8w3…-source") -> input name, for patched-copy trees. */
  inputByStoreName: Map<string, string>
  imports: Map<string, Set<string>>
  importedBy: Map<string, Set<string>>
  /** Input name -> self fileIds whose source references it (manifest.inputRefs). */
  inputRefsByInput: Map<string, string[]>
}

/**
 * Shared search filter for every tree in the app: keep a node when its own
 * text contains the (already-lowercased) query, or any descendant's does.
 * textOf returns null for nodes with no matchable text of their own (e.g.
 * file-list folders, which stay visible purely because of what's inside).
 */
export function subtreeMatches<T>(
  node: T,
  q: string,
  textOf: (n: T) => string | null,
  childrenOf: (n: T) => T[],
): boolean {
  if (q === "") return true
  if (textOf(node)?.toLowerCase().includes(q)) return true
  return childrenOf(node).some((c) => subtreeMatches(c, q, textOf, childrenOf))
}

/** File-list flavor: files match on their full relPath, folders only via contents. */
export function fileTreeMatches(n: FileTreeNode, q: string): boolean {
  return subtreeMatches(
    n,
    q,
    (x) => (x.fileId ? x.path : null),
    (x) => x.children,
  )
}

/** Parse a nixpkgs-style meta.position "file:line"; line absent when there is no trailing :<digits>. */
export function parsePosition(position: string): { file: string; line?: string } {
  const m = position.match(/^(.*):(\d+)$/)
  return m ? { file: m[1]!, line: m[2]! } : { file: position }
}

export function buildFlakeIndexes(manifest: Manifest): FlakeIndexes {
  const selfByStorePath = new Map(manifest.files.map((f) => [f.storePath, f]))
  const withPaths = Object.values(manifest.inputs).filter((i) => i.storePath)
  const inputPrefixes = withPaths
    .map((i) => ({ prefix: `${i.storePath!}/`, input: i.name }))
    .sort((a, b) => b.prefix.length - a.prefix.length)
  const inputByStoreName = new Map<string, string>()
  for (const i of withPaths) {
    const base = i.storePath!.split("/").pop()!
    if (!inputByStoreName.has(base)) inputByStoreName.set(base, i.name)
  }
  const imports = new Map<string, Set<string>>()
  const importedBy = new Map<string, Set<string>>()
  for (const e of manifest.importEdges) {
    ;(imports.get(e.from) ?? imports.set(e.from, new Set()).get(e.from)!).add(e.to)
    ;(importedBy.get(e.to) ?? importedBy.set(e.to, new Set()).get(e.to)!).add(e.from)
  }
  const inputRefsByInput = new Map<string, string[]>()
  // Older embedded exports may predate inputRefs — degrade to empty.
  for (const r of manifest.inputRefs ?? []) {
    ;(inputRefsByInput.get(r.input) ?? inputRefsByInput.set(r.input, []).get(r.input)!).push(r.file)
  }
  return { selfByStorePath, inputPrefixes, inputByStoreName, imports, importedBy, inputRefsByInput }
}

/** Resolve an option's file string (a store path or "<unknown-file>") to identity. */
export function resolveFile(storePath: string, manifest: Manifest, fx: FlakeIndexes): FileMeta {
  if (storePath === UNKNOWN_FILE) {
    return { id: "inline", relPath: UNKNOWN_FILE, origin: { kind: "unknown" }, storePath }
  }
  const self = fx.selfByStorePath.get(storePath)
  if (self) return { ...self }
  const selfPrefix = `${manifest.flake.path}/`
  if (storePath.startsWith(selfPrefix)) {
    // A self file outside the manifest listing (shouldn't happen, but degrade).
    const relPath = storePath.slice(selfPrefix.length)
    return {
      id: makeFileId({ kind: "self" }, relPath),
      relPath,
      origin: { kind: "self" },
      storePath,
    }
  }
  for (const { prefix, input } of fx.inputPrefixes) {
    if (storePath.startsWith(prefix)) {
      const relPath = storePath.slice(prefix.length)
      const origin = { kind: "input" as const, input }
      return { id: makeFileId(origin, relPath), relPath, origin, storePath }
    }
  }
  // Patched copy of an input: nixpkgs.applyPatches-style trees are named
  // "<hash>-<original store basename>" — recover the input from the middle.
  const m = storePath.match(/^\/nix\/store\/([^/]+)\/(.*)$/)
  if (m) {
    const [, root, relPath] = m
    const originalName = root!.replace(/^[a-z0-9]{32}-/, "")
    const input = fx.inputByStoreName.get(originalName)
    if (input) {
      const origin = { kind: "input" as const, input, patched: true as const }
      return { id: makeFileId(origin, relPath!), relPath: relPath!, origin, storePath }
    }
    // Unattributable — bucket by store root so siblings at least cluster.
    const group = `${originalName.replace(/^[a-z0-9]{32}-/, "")}@${root!.slice(0, 7)}`
    return {
      id: `unknown:${root}:${relPath}`,
      relPath: relPath!,
      origin: { kind: "unknown", group },
      storePath,
    }
  }
  return { id: `unknown:${storePath}`, relPath: storePath, origin: { kind: "unknown" }, storePath }
}

export function buildConfigIndexes(
  manifest: Manifest,
  config: ConfigData,
  fx: FlakeIndexes,
): ConfigIndexes {
  const filesById = new Map<string, FileMeta>()
  const refsByFile = new Map<string, FileOptionRefs>()

  for (const [storePath, refs] of Object.entries(config.fileIndex)) {
    const meta = resolveFile(storePath, manifest, fx)
    filesById.set(meta.id, meta)
    const existing = refsByFile.get(meta.id)
    if (existing) {
      existing.defines.push(...refs.defines)
      existing.declares.push(...refs.declares)
    } else {
      refsByFile.set(meta.id, { defines: [...refs.defines], declares: [...refs.declares] })
    }
  }
  // Blobs from older extractors can carry duplicate indices (same option
  // defined twice by one file) — dedupe so keyed lists never collide.
  for (const refs of refsByFile.values()) {
    refs.defines = [...new Set(refs.defines)]
    refs.declares = [...new Set(refs.declares)]
  }

  const tree = buildTree(filesById, refsByFile)
  const fileToNodes = buildFileToNodes(tree)
  const optionsByLoc = new Map<string, number>()
  const optionLocsLower = new Array<string>(config.options.length)
  config.options.forEach((o, i) => {
    const loc = o.loc.join(".")
    optionsByLoc.set(loc, i)
    optionLocsLower[i] = loc.toLowerCase()
  })
  return { tree, fileToNodes, refsByFile, filesById, optionsByLoc, optionLocsLower }
}

/**
 * Shared lazy directory-walk behind both tree builders (buildTree,
 * buildFileTree): resolve — creating on first sight — the chain of directory
 * nodes for `parts`, keyed by the accumulated "<keyPrefix>/<p1>/<p2>" path so
 * a directory reached twice reuses one node. Returns the deepest node.
 */
function dirResolver<T extends { children: T[] }>(
  makeDir: (acc: string, label: string) => T,
): (from: T, keyPrefix: string, parts: string[]) => T {
  const dirs = new Map<string, T>()
  return (from, keyPrefix, parts) => {
    let node = from
    let acc = keyPrefix
    for (const part of parts) {
      acc += `/${part}`
      let child = dirs.get(acc)
      if (!child) {
        child = makeDir(acc, part)
        dirs.set(acc, child)
        node.children.push(child)
      }
      node = child
    }
    return node
  }
}

function buildTree(
  filesById: Map<string, FileMeta>,
  refsByFile: Map<string, FileOptionRefs>,
): TreeNode {
  const root: TreeNode = { id: "root", label: "", children: [], customized: 0, declares: 0 }
  const dirFor = dirResolver<TreeNode>((acc, label) => ({
    id: `dir:${acc}`,
    label,
    children: [],
    customized: 0,
    declares: 0,
  }))

  const inputRoots = new Map<string, TreeNode>()
  const inputRoot = (input: string): TreeNode => {
    let node = inputRoots.get(input)
    if (!node) {
      node = { id: `input:${input}`, label: input, children: [], customized: 0, declares: 0 }
      inputRoots.set(input, node)
    }
    return node
  }

  for (const meta of filesById.values()) {
    const refs = refsByFile.get(meta.id)!
    const leaf: TreeNode = {
      id: meta.id,
      label: meta.relPath.split("/").pop()!,
      fileId: meta.id,
      children: [],
      customized: refs.defines.length,
      declares: refs.declares.length,
    }
    if (meta.id === "inline") {
      leaf.label = "(inline modules)"
      root.children.push(leaf)
    } else if (meta.origin.kind === "self") {
      const parts = meta.relPath.split("/")
      dirFor(root, "self", parts.slice(0, -1)).children.push(leaf)
    } else if (meta.origin.kind === "input") {
      const parts = meta.relPath.split("/")
      dirFor(
        inputRoot(meta.origin.input),
        `input/${meta.origin.input}`,
        parts.slice(0, -1),
      ).children.push(leaf)
    } else if (meta.origin.group) {
      const parts = meta.relPath.split("/")
      dirFor(
        inputRoot(meta.origin.group),
        `input/${meta.origin.group}`,
        parts.slice(0, -1),
      ).children.push(leaf)
    } else {
      leaf.label = meta.relPath
      root.children.push(leaf)
    }
  }

  root.children.push(...inputRoots.values())
  sortAndSum(root)

  // Re-pin the input groups AFTER the flake's own entries (sortAndSum just
  // interleaved everything dirs-first-alphabetically), alphabetical with
  // nixpkgs last — it dwarfs the others and would bury them.
  const inputSet = new Set<TreeNode>(inputRoots.values())
  const inputs = root.children
    .filter((c) => inputSet.has(c))
    .sort((a, b) =>
      a.label === "nixpkgs" ? 1 : b.label === "nixpkgs" ? -1 : a.label.localeCompare(b.label),
    )
  root.children = [...root.children.filter((c) => !inputSet.has(c)), ...inputs]
  return root
}

/**
 * Sort children (dirs first, then leaves, alphabetical) and roll up counts.
 * Deliberately the OPPOSITE order of the file list's buildFileTree/sortLevel
 * (files first): this tree reads as a namespace, containers leading; the
 * file list keeps a group's root files (flake.nix) visible above its folders.
 */
function sortAndSum(node: TreeNode): void {
  for (const c of node.children) sortAndSum(c)
  node.children.sort((a, b) => {
    const ad = a.children.length > 0 ? 0 : 1
    const bd = b.children.length > 0 ? 0 : 1
    return ad - bd || a.label.localeCompare(b.label)
  })
  if (node.children.length > 0) {
    node.customized += node.children.reduce((s, c) => s + c.customized, 0)
    node.declares += node.children.reduce((s, c) => s + c.declares, 0)
  }
}

// ------------------------------------------------------------ right pane

/** Folder tree for the file list: files sort before folders at every level. */
export interface FileTreeNode {
  /** Dirs: "fdir:<groupKey>/<dirpath>"; files: the fileId. */
  id: string
  label: string
  /** relPath of the file, or the dir path ("" on the group root). */
  path: string
  fileId?: string
  colorKey: string
  children: FileTreeNode[]
}

export function buildFileTree(
  files: { id: string; relPath: string; colorKey: string }[],
  groupKey: string,
): FileTreeNode {
  const root: FileTreeNode = {
    id: `fdir:${groupKey}`,
    label: "",
    path: "",
    colorKey: groupKey,
    children: [],
  }
  const dirFor = dirResolver<FileTreeNode>((acc, label) => ({
    id: `fdir:${groupKey}${acc}`,
    label,
    path: acc.slice(1),
    colorKey: groupKey,
    children: [],
  }))
  for (const f of files) {
    const parts = f.relPath.split("/")
    dirFor(root, "", parts.slice(0, -1)).children.push({
      id: f.id,
      label: parts[parts.length - 1]!,
      path: f.relPath,
      fileId: f.id,
      colorKey: f.colorKey,
      children: [],
    })
  }
  // Files before folders — deliberately the opposite of the module tree's
  // sortAndSum (dirs first); see the comment there for why each fits its pane.
  const sortLevel = (n: FileTreeNode) => {
    n.children.sort(
      (a, b) => (a.fileId ? 0 : 1) - (b.fileId ? 0 : 1) || a.label.localeCompare(b.label),
    )
    n.children.forEach(sortLevel)
  }
  sortLevel(root)
  return root
}

/**
 * Input name from a TREE-NODE id — tolerates both the "input:<name>" group
 * roots buildTree emits and "input:<name>:<rel>" file-leaf ids, which is why
 * this is not parseFileId (that grammar rejects the two-segment root form).
 */
export function inputNameOf(id: string): string | null {
  return id.startsWith("input:") ? id.slice("input:".length).split(":")[0]! : null
}

/** Display label for an input: "stable → nixpkgs" when root-level aliases follow it. */
export function inputLabel(i: InputInfo): string {
  return i.aliases?.length ? `${i.aliases.join(", ")} → ${i.name}` : i.name
}

/** File-list group a file belongs to ("self" | "input:<name>"), null if none. */
export function groupKeyOf(origin: FileOrigin): string | null {
  if (origin.kind === "self") return "self"
  if (origin.kind === "input") return `input:${origin.input}`
  if (origin.group) return `input:${origin.group}`
  return null
}

/** Folder-node ids on the way to relPath within a group (for auto-expand). */
export function fileTreeAncestorIds(groupKey: string, relPath: string): string[] {
  const ids: string[] = []
  let path = ""
  for (const part of relPath.split("/").slice(0, -1)) {
    path = path ? `${path}/${part}` : part
    ids.push(`fdir:${groupKey}/${path}`)
  }
  return ids
}

function buildFileToNodes(root: TreeNode): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  const walk = (node: TreeNode, ancestors: string[]) => {
    if (node.fileId) {
      map.set(node.fileId, new Set([...ancestors, node.id]))
    }
    for (const c of node.children) walk(c, [...ancestors, node.id])
  }
  walk(root, [])
  return map
}
