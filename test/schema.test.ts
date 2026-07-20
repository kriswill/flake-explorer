// FileEntry.id codec — a client-server protocol (serve's /data/file/<id>
// route re-derives input files from the id), so round-trips must be exact.

import { describe, expect, test } from "bun:test"
import {
  displayLabel,
  isConfigData,
  isManifest,
  isPackageData,
  makeFileId,
  parseFileId,
  SCHEMA_VERSION,
} from "../src/schema"

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
})
