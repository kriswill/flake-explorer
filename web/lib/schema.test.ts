// FileEntry.id codec — a client-server protocol (serve's /data/file/<id>
// route re-derives input files from the id), so round-trips must be exact.

import { describe, expect, test } from "bun:test"
import {
  displayLabel,
  isConfigData,
  isGraphData,
  isManifest,
  isPackageData,
  makeFileId,
  parseFileId,
  SCHEMA_VERSION,
} from "./schema"

describe("file id codec", () => {
  test("self and input ids round-trip through make/parse", () => {
    expect(makeFileId({ kind: "self" }, "modules/a.nix")).toBe("self:modules/a.nix")
    expect(makeFileId({ kind: "input", input: "sops-nix" }, "mod/d.nix")).toBe(
      "input:sops-nix:mod/d.nix",
    )
    expect(parseFileId("self:modules/a.nix")).toEqual({ kind: "self", relPath: "modules/a.nix" })
    expect(parseFileId("input:sops-nix:mod/d.nix")).toEqual({
      kind: "input",
      input: "sops-nix",
      relPath: "mod/d.nix",
    })
  })

  test("opaque (unknown-bucket) ids parse to null and label as-is", () => {
    expect(parseFileId("unknown:source@abc1234")).toBe(null)
    expect(parseFileId("inline")).toBe(null)
    expect(displayLabel("inline")).toBe("inline")
    expect(displayLabel("self:lib/c.nix")).toBe("lib/c.nix")
  })
})

describe("runtime shape guards", () => {
  // These stand between "JSON.parse(...) as T" and the index builders, which
  // dereference .options/.fileIndex/.files without checking. A blob from an
  // interrupted extractor can carry the right version and nothing else.
  const manifest = () => ({
    version: SCHEMA_VERSION,
    flake: { ref: "/etc/test", path: "/nix/store/aaa-source" },
    files: [],
    configurations: [],
    packages: [],
    inputs: {},
    outputs: { kind: "attrset", children: {} },
  })
  const config = () => ({ version: SCHEMA_VERSION, id: "nixos/test", options: [], fileIndex: {} })
  const pkg = () => ({ version: SCHEMA_VERSION, id: "p", outputs: [], deps: {} })

  test("well-formed documents pass", () => {
    expect(isManifest(manifest())).toBe(true)
    expect(isConfigData(config())).toBe(true)
    expect(isPackageData(pkg())).toBe(true)
  })

  test("a right-version document missing what the index builders read is rejected", () => {
    // The actual failure mode: version gate passes, then buildConfigIndexes
    // hits Object.entries(undefined) and throws a bare TypeError instead of
    // the "re-run extract" message.
    expect(isConfigData({ ...config(), options: undefined })).toBe(false)
    expect(isConfigData({ ...config(), fileIndex: undefined })).toBe(false)
    expect(isConfigData({ ...config(), options: "not-an-array" })).toBe(false)
    expect(isManifest({ ...manifest(), files: undefined })).toBe(false)
    expect(isManifest({ ...manifest(), inputs: [] })).toBe(false) // array, not a record
    expect(isManifest({ ...manifest(), flake: { ref: "x" } })).toBe(false) // no path
    expect(isPackageData({ ...pkg(), outputs: undefined })).toBe(false)
  })

  test("a version mismatch is still rejected", () => {
    expect(isManifest({ ...manifest(), version: 2 })).toBe(false)
    expect(isConfigData({ ...config(), version: 0 })).toBe(false)
    expect(isPackageData({ ...pkg(), version: undefined })).toBe(false)
  })

  test("non-objects never pass", () => {
    for (const v of [null, undefined, 1, "x", [], true]) {
      expect(isManifest(v)).toBe(false)
      expect(isConfigData(v)).toBe(false)
      expect(isPackageData(v)).toBe(false)
    }
  })

  test("unknown extra fields still pass — blobs stay forward-compatible", () => {
    expect(isManifest({ ...manifest(), somethingNew: 1 })).toBe(true)
    expect(isConfigData({ ...config(), somethingNew: 1 })).toBe(true)
  })

  // manifest.graphs is #[serde(default)] on the Rust side: an extractor from
  // before dependency graphs existed emits a v1 manifest with NO graphs key,
  // and it must still load. (The manifest fixture above deliberately has none.)
  test("a manifest without the additive graphs list still passes", () => {
    expect("graphs" in manifest()).toBe(false)
    expect(isManifest(manifest())).toBe(true)
  })
})

describe("isGraphData", () => {
  // Shaped after the real documents (see scratchpad FIELD-TABLE): root is an
  // index into nodes and is NEVER assumed to be 0 (real roots: 909/845/10887);
  // every optional field is ABSENT, not null.
  const graph = () => ({
    version: SCHEMA_VERSION,
    id: "packages/x86_64-linux/default",
    root: 1,
    extractedAt: "2026-07-29T06:52:37.030Z",
    nodes: [
      { drvPath: "/nix/store/aaa-dep.drv", name: "dep", system: "x86_64-linux", outputs: [] },
      {
        drvPath: "/nix/store/bbb-root.drv",
        name: "root",
        system: "x86_64-linux",
        outputs: [{ name: "out", path: "/nix/store/ccc-root", present: false }],
      },
    ],
    edges: [[], [0]],
    tiers: { presence: true, sizes: false, dryRun: false, substituters: false },
    stats: { nodeCount: 2, edgeCount: 1, outputPathCount: 1, uniqueOutputPathCount: 1 },
    warnings: [],
  })

  test("a well-formed graph document passes", () => {
    expect(isGraphData(graph())).toBe(true)
  })

  test("a right-version document missing what the index builder reads is rejected", () => {
    // buildGraphIndexes walks nodes and edges and reads root; the renderers
    // read tiers and stats unconditionally. Without these the failure is a
    // bare TypeError deep in a builder, not the "re-run extract" message.
    expect(isGraphData({ ...graph(), nodes: undefined })).toBe(false)
    expect(isGraphData({ ...graph(), edges: undefined })).toBe(false)
    expect(isGraphData({ ...graph(), root: undefined })).toBe(false)
    expect(isGraphData({ ...graph(), root: "1" })).toBe(false)
    expect(isGraphData({ ...graph(), tiers: undefined })).toBe(false)
    expect(isGraphData({ ...graph(), stats: undefined })).toBe(false)
    expect(isGraphData({ ...graph(), edges: {} })).toBe(false) // record, not an array
  })

  test("a version mismatch is still rejected", () => {
    expect(isGraphData({ ...graph(), version: 2 })).toBe(false)
    expect(isGraphData({ ...graph(), version: undefined })).toBe(false)
  })

  test("non-objects never pass", () => {
    for (const v of [null, undefined, 1, "x", [], true]) expect(isGraphData(v)).toBe(false)
  })

  test("the optional tiers stay optional — a T0-only graph passes", () => {
    // The real nebula capture: all tiers off, no dryRun key, no absentCount,
    // no present/narSize anywhere. Absence is the normal case, not an error.
    const t0 = graph()
    t0.tiers = { presence: false, sizes: false, dryRun: false, substituters: false }
    t0.nodes[1]!.outputs = [{ name: "out", path: "/nix/store/ccc-root" }] as never
    expect("dryRun" in t0).toBe(false)
    expect("absentCount" in t0.stats).toBe(false)
    expect(isGraphData(t0)).toBe(true)
  })

  test("unknown extra fields still pass — blobs stay forward-compatible", () => {
    expect(isGraphData({ ...graph(), somethingNew: 1 })).toBe(true)
  })
})
