// Cheap manifest pass: flake metadata + outputs tree + file list + import
// graph + git info. Always regenerated; the expensive per-configuration
// options blobs are extracted separately (options.ts) on demand.

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  EXTRACTOR_VERSION,
  makeFileId,
  SCHEMA_VERSION,
  type FileEntry,
  type InputInfo,
  type Manifest,
  type OutputNode,
} from "../schema";
import { lastCommits, repoPrefix } from "./git";
import { importGraph } from "./imports";
import {
  evalExtract,
  flakeMetadata,
  flakeShow,
  type FlakeMetadataJson,
  type InputsTreeNode,
  type ManifestEval,
} from "./run-nix";

export interface ManifestOptions {
  allSystems?: boolean;
  timeoutMs?: number;
}

export async function buildManifest(flakeRef: string, opts: ManifestOptions = {}): Promise<Manifest> {
  const warnings: string[] = [];
  const timeoutMs = opts.timeoutMs ?? 300_000;

  const meta = await flakeMetadata(flakeRef, timeoutMs);
  const localCheckout = detectLocalCheckout(flakeRef, meta);

  const [showJson, ev] = await Promise.all([
    flakeShow(flakeRef, opts.allSystems ?? false, timeoutMs).catch((e) => {
      warnings.push(`nix flake show failed: ${String(e).split("\n")[0]}`);
      return null;
    }),
    evalExtract<ManifestEval>({ flakeRef, mode: "manifest" }, timeoutMs),
  ]);

  const inputs = inputInfos(meta, ev, warnings);
  const files = await fileEntries(ev, localCheckout, warnings);
  const selfFiles = files.filter((f) => f.origin.kind === "self");
  const read = (relPath: string) => Bun.file(`${ev.self}/${relPath}`).text();
  const importEdges = await importGraph(
    selfFiles.map((f) => f.relPath),
    read,
    (relPath) => makeFileId({ kind: "self" }, relPath),
  );

  return {
    version: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    extractor: EXTRACTOR_VERSION,
    flake: {
      ref: flakeRef,
      path: ev.self,
      description: meta.description ?? ev.description ?? undefined,
      rev: meta.revision,
      narHash: meta.locked?.narHash,
    },
    outputs: showJson ? normalizeShow(showJson) : { kind: "attrset", children: {} },
    inputs,
    files,
    importEdges,
    configurations: ev.configurations.map(({ kind, n }) => ({
      id: `${kind}/${n}`,
      kind,
      name: n,
      dataFile: `config/${kind}.${safeName(n)}.json`,
      status: "pending" as const,
    })),
    grafts: ev.grafts ?? [],
    outputNames: ev.outputNames ?? {},
    warnings,
  };
}

/**
 * Config names are arbitrary Nix attr names — quoted attrs may contain "/",
 * enough to escape the data dir through join(outDir, dataFile). Names in the
 * serve route's charset pass through; anything else becomes a slug plus a
 * short collision hash (still matching /^[\w@%.+-]+$/, so it stays fetchable).
 */
function safeName(name: string): string {
  if (/^[\w@+.-]+$/.test(name)) return name;
  return `${name.replace(/[^\w@+.-]/g, "_")}-${Bun.hash(name).toString(36).slice(0, 8)}`;
}

/** Existing local directory of a path-like flakeref (`path:` prefix and ?query stripped), or null. */
export function localFlakeDir(ref: string): string | null {
  const bare = ref.replace(/^path:/, "").replace(/\?.*$/, "");
  if ((bare.startsWith("/") || bare.startsWith(".")) && existsSync(bare) && statSync(bare).isDirectory()) {
    return bare;
  }
  return null;
}

/** A path-like flakeref (possibly `path:`-prefixed) that exists locally. */
function detectLocalCheckout(flakeRef: string, meta: FlakeMetadataJson): string | null {
  const dir = localFlakeDir(flakeRef);
  if (dir) return resolve(dir);
  const m = meta.resolvedUrl?.match(/^(?:path:|git\+file:\/\/)([^?]+)/);
  if (m && existsSync(m[1]!)) return m[1]!;
  return null;
}

/**
 * Flatten the recursive inputs tree (eval side: store paths) against the
 * lock graph (metadata side: provenance), breadth-first so direct inputs
 * claim plain names; a transitive input gets "parent/child" unless its lock
 * node was already covered (follows dedup).
 */
function inputInfos(meta: FlakeMetadataJson, ev: ManifestEval, warnings: string[]): Record<string, InputInfo> {
  const out: Record<string, InputInfo> = {};
  const seenNodes = new Set<string>();
  interface Item {
    name: string;
    nodeKey: string | null;
    evNode: InputsTreeNode | undefined;
    depth: number;
    follows?: string;
  }
  const queue: Item[] = [];
  const rootNode = meta.locks.nodes[meta.locks.root];
  for (const [name, ref] of Object.entries(rootNode?.inputs ?? {})) {
    queue.push({
      name,
      nodeKey: Array.isArray(ref) ? resolveFollows(meta, ref) : ref,
      evNode: ev.inputs[name],
      depth: 0,
      follows: Array.isArray(ref) ? ref.join("/") : undefined,
    });
  }
  while (queue.length) {
    const item = queue.shift()!;
    const node = item.nodeKey ? meta.locks.nodes[item.nodeKey] : undefined;
    if (!node) {
      if (item.depth === 0) warnings.push(`flake.lock: could not resolve input "${item.name}"`);
      continue;
    }
    if (seenNodes.has(item.nodeKey!)) continue;
    seenNodes.add(item.nodeKey!);
    out[item.name] = {
      name: item.name,
      nodeKey: item.nodeKey!,
      ...(item.depth > 0 ? { transitive: true as const } : {}),
      type: node.locked?.type ?? node.original?.type ?? "unknown",
      url: node.locked?.url ?? urlFromLocked(node.locked),
      ref: node.locked?.ref ?? node.original?.ref,
      rev: node.locked?.rev,
      narHash: node.locked?.narHash,
      lastModified: node.locked?.lastModified,
      storePath: item.evNode?.path ?? undefined,
      follows: item.follows,
    };
    for (const [childName, childRef] of Object.entries(node.inputs ?? {})) {
      queue.push({
        name: `${item.name}/${childName}`,
        nodeKey: Array.isArray(childRef) ? resolveFollows(meta, childRef) : childRef,
        evNode: item.evNode?.inputs?.[childName],
        depth: item.depth + 1,
        follows: Array.isArray(childRef) ? childRef.join("/") : undefined,
      });
    }
  }
  return out;
}

function urlFromLocked(locked?: { type: string; owner?: string; repo?: string; path?: string }): string | undefined {
  if (!locked) return undefined;
  if (locked.type === "github" && locked.owner) return `https://github.com/${locked.owner}/${locked.repo}`;
  if (locked.type === "path") return locked.path;
  return undefined;
}

/** Walk a follows path (["nixpkgs"] or ["home-manager","nixpkgs"]) to its node key. */
function resolveFollows(meta: FlakeMetadataJson, path: string[]): string | null {
  let key = meta.locks.root;
  for (const seg of path) {
    const ref: string | string[] | undefined = meta.locks.nodes[key]?.inputs?.[seg];
    if (ref === undefined) return null;
    if (Array.isArray(ref)) {
      const resolved = resolveFollows(meta, ref);
      if (!resolved) return null;
      key = resolved;
    } else {
      key = ref;
    }
  }
  return key;
}

async function fileEntries(
  ev: ManifestEval,
  localCheckout: string | null,
  warnings: string[],
): Promise<FileEntry[]> {
  const selfPrefix = `${ev.self}/`;
  const entries: FileEntry[] = ev.files
    .filter((f) => f.startsWith(selfPrefix))
    .map((storePath) => ({
      id: makeFileId({ kind: "self" }, storePath.slice(selfPrefix.length)),
      relPath: storePath.slice(selfPrefix.length),
      origin: { kind: "self" as const },
      storePath,
    }));

  if (localCheckout) {
    const prefix = await repoPrefix(localCheckout);
    if (prefix === null) {
      warnings.push(`${localCheckout} is not a git work tree — no per-file commit info`);
    } else {
      const commits = await lastCommits(localCheckout, warnings);
      for (const e of entries) {
        const info = commits.get(prefix + e.relPath);
        if (info) e.git = info;
      }
    }
  }
  return entries;
}

// --------------------------------------------------------------- flake show

/**
 * Normalize `nix flake show --json`. Two formats exist:
 * - classic (Nix/Lix): nested plain objects; leaves carry {type, name?, description?}
 * - Determinate Nix "inventory" v2: {version: 2, inventory: {<out>: {doc, output?: {children}}}}
 *   with nodes {children} | {filtered: true} | {what, derivation?, shortDescription?, forSystems?}
 */
export function normalizeShow(json: unknown): OutputNode {
  const j = json as Record<string, unknown>;
  if (j && typeof j === "object" && "inventory" in j) {
    const children: Record<string, OutputNode> = {};
    for (const [name, entry] of Object.entries(j.inventory as Record<string, Record<string, unknown>>)) {
      const output = entry?.output as Record<string, unknown> | undefined;
      children[name] = output ? inventoryNode(output) : { kind: "unknown" };
    }
    return { kind: "attrset", children };
  }
  return classicNode(j);
}

function inventoryNode(node: Record<string, unknown>): OutputNode {
  if (node.filtered === true) return { kind: "omitted" };
  if (node.children && typeof node.children === "object") {
    const children: Record<string, OutputNode> = {};
    for (const [name, child] of Object.entries(node.children as Record<string, Record<string, unknown>>)) {
      children[name] = inventoryNode(child);
    }
    return { kind: "attrset", children };
  }
  if (typeof node.what === "string") {
    const drv = node.derivation as { name?: string } | undefined;
    return {
      kind: "leaf",
      type: node.what,
      name: drv?.name,
      description: typeof node.shortDescription === "string" && node.shortDescription ? node.shortDescription : undefined,
    };
  }
  return { kind: "unknown" };
}

function classicNode(node: unknown): OutputNode {
  if (node === null || typeof node !== "object") return { kind: "unknown" };
  const n = node as Record<string, unknown>;
  if (n.unknown === true) return { kind: "unknown" };
  if (typeof n.type === "string") {
    return {
      kind: "leaf",
      type: n.type,
      name: typeof n.name === "string" ? n.name : undefined,
      description: typeof n.description === "string" && n.description ? n.description : undefined,
    };
  }
  const keys = Object.keys(n);
  if (keys.length === 0) return { kind: "omitted" };
  const children: Record<string, OutputNode> = {};
  for (const k of keys) children[k] = classicNode(n[k]);
  return { kind: "attrset", children };
}
