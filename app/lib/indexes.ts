// Pure data-shaping for the SPA: file identity resolution, the left-pane
// module tree, and the O(1) lookup maps behind hover cross-highlighting.
// Built once per (manifest, config) load and cached OUTSIDE runes state —
// these are big, immutable structures.

import type { ConfigData, FileEntry, FileOptionRefs, FileOrigin, Manifest } from "../../src/schema";
import { UNKNOWN_FILE } from "../../src/schema";

export interface FileMeta {
  id: string;
  relPath: string;
  origin: FileOrigin;
  storePath: string;
  git?: FileEntry["git"];
}

export interface TreeNode {
  id: string; // "dir:self:modules/hosts" | fileId | "input:darwin" | "inline"
  label: string;
  fileId?: string; // set on file leaves
  children: TreeNode[];
  /** Subtree totals for badges. */
  customized: number;
  declares: number;
}

export interface ConfigIndexes {
  tree: TreeNode;
  /** fileId -> tree node ids to highlight (the file's leaf + all ancestors). */
  fileToNodes: Map<string, Set<string>>;
  /** fileId -> option refs into config.options (defines = customized only). */
  refsByFile: Map<string, FileOptionRefs>;
  /** Every file participating in this config, by id. */
  filesById: Map<string, FileMeta>;
}

export interface FlakeIndexes {
  selfByStorePath: Map<string, FileEntry>;
  /** Input storePath prefixes, longest first, for origin attribution. */
  inputPrefixes: { prefix: string; input: string }[];
  /** Store basename ("w8w3…-source") -> input name, for patched-copy trees. */
  inputByStoreName: Map<string, string>;
  imports: Map<string, Set<string>>;
  importedBy: Map<string, Set<string>>;
}

export function buildFlakeIndexes(manifest: Manifest): FlakeIndexes {
  const selfByStorePath = new Map(manifest.files.map((f) => [f.storePath, f]));
  const withPaths = Object.values(manifest.inputs).filter((i) => i.storePath);
  const inputPrefixes = withPaths
    .map((i) => ({ prefix: i.storePath! + "/", input: i.name }))
    .sort((a, b) => b.prefix.length - a.prefix.length);
  const inputByStoreName = new Map<string, string>();
  for (const i of withPaths) {
    const base = i.storePath!.split("/").pop()!;
    if (!inputByStoreName.has(base)) inputByStoreName.set(base, i.name);
  }
  const imports = new Map<string, Set<string>>();
  const importedBy = new Map<string, Set<string>>();
  for (const e of manifest.importEdges) {
    (imports.get(e.from) ?? imports.set(e.from, new Set()).get(e.from)!).add(e.to);
    (importedBy.get(e.to) ?? importedBy.set(e.to, new Set()).get(e.to)!).add(e.from);
  }
  return { selfByStorePath, inputPrefixes, inputByStoreName, imports, importedBy };
}

/** Resolve an option's file string (a store path or "<unknown-file>") to identity. */
export function resolveFile(storePath: string, manifest: Manifest, fx: FlakeIndexes): FileMeta {
  if (storePath === UNKNOWN_FILE) {
    return { id: "inline", relPath: UNKNOWN_FILE, origin: { kind: "unknown" }, storePath };
  }
  const self = fx.selfByStorePath.get(storePath);
  if (self) return { ...self };
  const selfPrefix = manifest.flake.path + "/";
  if (storePath.startsWith(selfPrefix)) {
    // A self file outside the manifest listing (shouldn't happen, but degrade).
    const relPath = storePath.slice(selfPrefix.length);
    return { id: `self:${relPath}`, relPath, origin: { kind: "self" }, storePath };
  }
  for (const { prefix, input } of fx.inputPrefixes) {
    if (storePath.startsWith(prefix)) {
      const relPath = storePath.slice(prefix.length);
      return { id: `input:${input}:${relPath}`, relPath, origin: { kind: "input", input }, storePath };
    }
  }
  // Patched copy of an input: nixpkgs.applyPatches-style trees are named
  // "<hash>-<original store basename>" — recover the input from the middle.
  const m = storePath.match(/^\/nix\/store\/([^/]+)\/(.*)$/);
  if (m) {
    const [, root, relPath] = m;
    const originalName = root!.replace(/^[a-z0-9]{32}-/, "");
    const input = fx.inputByStoreName.get(originalName);
    if (input) {
      return {
        id: `input:${input}:${relPath}`,
        relPath: relPath!,
        origin: { kind: "input", input, patched: true },
        storePath,
      };
    }
    // Unattributable — bucket by store root so siblings at least cluster.
    const group = `${originalName.replace(/^[a-z0-9]{32}-/, "")}@${root!.slice(0, 7)}`;
    return { id: `unknown:${root}:${relPath}`, relPath: relPath!, origin: { kind: "unknown", group }, storePath };
  }
  return { id: `unknown:${storePath}`, relPath: storePath, origin: { kind: "unknown" }, storePath };
}

export function buildConfigIndexes(manifest: Manifest, config: ConfigData, fx: FlakeIndexes): ConfigIndexes {
  const filesById = new Map<string, FileMeta>();
  const refsByFile = new Map<string, FileOptionRefs>();

  for (const [storePath, refs] of Object.entries(config.fileIndex)) {
    const meta = resolveFile(storePath, manifest, fx);
    filesById.set(meta.id, meta);
    const existing = refsByFile.get(meta.id);
    if (existing) {
      existing.defines.push(...refs.defines);
      existing.declares.push(...refs.declares);
    } else {
      refsByFile.set(meta.id, { defines: [...refs.defines], declares: [...refs.declares] });
    }
  }

  const tree = buildTree(filesById, refsByFile);
  const fileToNodes = buildFileToNodes(tree);
  return { tree, fileToNodes, refsByFile, filesById };
}

function buildTree(filesById: Map<string, FileMeta>, refsByFile: Map<string, FileOptionRefs>): TreeNode {
  const root: TreeNode = { id: "root", label: "", children: [], customized: 0, declares: 0 };
  const dirNodes = new Map<string, TreeNode>();

  const dirFor = (parent: TreeNode, parts: string[], idPrefix: string): TreeNode => {
    let node = parent;
    let acc = idPrefix;
    for (const part of parts) {
      acc += "/" + part;
      let child = dirNodes.get(acc);
      if (!child) {
        child = { id: `dir:${acc}`, label: part, children: [], customized: 0, declares: 0 };
        dirNodes.set(acc, child);
        node.children.push(child);
      }
      node = child;
    }
    return node;
  };

  const inputRoots = new Map<string, TreeNode>();
  const inputRoot = (input: string): TreeNode => {
    let node = inputRoots.get(input);
    if (!node) {
      node = { id: `input:${input}`, label: input, children: [], customized: 0, declares: 0 };
      inputRoots.set(input, node);
    }
    return node;
  };

  for (const meta of filesById.values()) {
    const refs = refsByFile.get(meta.id)!;
    const leaf: TreeNode = {
      id: meta.id,
      label: meta.relPath.split("/").pop()!,
      fileId: meta.id,
      children: [],
      customized: refs.defines.length,
      declares: refs.declares.length,
    };
    if (meta.id === "inline") {
      leaf.label = "(inline modules)";
      root.children.push(leaf);
    } else if (meta.origin.kind === "self") {
      const parts = meta.relPath.split("/");
      dirFor(root, parts.slice(0, -1), "self").children.push(leaf);
    } else if (meta.origin.kind === "input") {
      const parts = meta.relPath.split("/");
      dirFor(inputRoot(meta.origin.input), parts.slice(0, -1), `input/${meta.origin.input}`).children.push(leaf);
    } else if (meta.origin.group) {
      const parts = meta.relPath.split("/");
      dirFor(inputRoot(meta.origin.group), parts.slice(0, -1), `input/${meta.origin.group}`).children.push(leaf);
    } else {
      leaf.label = meta.relPath;
      root.children.push(leaf);
    }
  }

  // Inputs grouped after self files, alphabetical; nixpkgs last (largest).
  const inputs = [...inputRoots.values()].sort((a, b) =>
    a.label === "nixpkgs" ? 1 : b.label === "nixpkgs" ? -1 : a.label.localeCompare(b.label),
  );
  root.children.push(...inputs);

  sortAndSum(root);
  return root;
}

/** Sort children (dirs first, then leaves, alphabetical) and roll up counts. */
function sortAndSum(node: TreeNode): void {
  for (const c of node.children) sortAndSum(c);
  node.children.sort((a, b) => {
    const ad = a.children.length > 0 ? 0 : 1;
    const bd = b.children.length > 0 ? 0 : 1;
    return ad - bd || a.label.localeCompare(b.label);
  });
  if (node.children.length > 0) {
    node.customized += node.children.reduce((s, c) => s + c.customized, 0);
    node.declares += node.children.reduce((s, c) => s + c.declares, 0);
  }
}

// ------------------------------------------------------------ right pane

/** Folder tree for the file list: files sort before folders at every level. */
export interface FileTreeNode {
  /** Dirs: "fdir:<groupKey>/<dirpath>"; files: the fileId. */
  id: string;
  label: string;
  /** relPath of the file, or the dir path ("" on the group root). */
  path: string;
  fileId?: string;
  colorKey: string;
  children: FileTreeNode[];
}

export function buildFileTree(
  files: { id: string; relPath: string; colorKey: string }[],
  groupKey: string,
): FileTreeNode {
  const root: FileTreeNode = { id: `fdir:${groupKey}`, label: "", path: "", colorKey: groupKey, children: [] };
  const dirs = new Map<string, FileTreeNode>([["", root]]);
  const dirFor = (parts: string[]): FileTreeNode => {
    let path = "";
    let node = root;
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      let child = dirs.get(path);
      if (!child) {
        child = { id: `fdir:${groupKey}/${path}`, label: part, path, colorKey: groupKey, children: [] };
        dirs.set(path, child);
        node.children.push(child);
      }
      node = child;
    }
    return node;
  };
  for (const f of files) {
    const parts = f.relPath.split("/");
    dirFor(parts.slice(0, -1)).children.push({
      id: f.id,
      label: parts[parts.length - 1]!,
      path: f.relPath,
      fileId: f.id,
      colorKey: f.colorKey,
      children: [],
    });
  }
  const sortLevel = (n: FileTreeNode) => {
    n.children.sort((a, b) => (a.fileId ? 0 : 1) - (b.fileId ? 0 : 1) || a.label.localeCompare(b.label));
    n.children.forEach(sortLevel);
  };
  sortLevel(root);
  return root;
}

/** File-list group a file belongs to ("self" | "input:<name>"), null if none. */
export function groupKeyOf(origin: FileOrigin): string | null {
  if (origin.kind === "self") return "self";
  if (origin.kind === "input") return `input:${origin.input}`;
  if (origin.group) return `input:${origin.group}`;
  return null;
}

/** Folder-node ids on the way to relPath within a group (for auto-expand). */
export function fileTreeAncestorIds(groupKey: string, relPath: string): string[] {
  const ids: string[] = [];
  let path = "";
  for (const part of relPath.split("/").slice(0, -1)) {
    path = path ? `${path}/${part}` : part;
    ids.push(`fdir:${groupKey}/${path}`);
  }
  return ids;
}

function buildFileToNodes(root: TreeNode): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const walk = (node: TreeNode, ancestors: string[]) => {
    if (node.fileId) {
      map.set(node.fileId, new Set([...ancestors, node.id]));
    }
    for (const c of node.children) walk(c, [...ancestors, node.id]);
  };
  walk(root, []);
  return map;
}
