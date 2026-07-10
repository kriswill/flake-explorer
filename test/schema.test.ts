// FileEntry.id codec — a client-server protocol (serve's /data/file/<id>
// route re-derives input files from the id), so round-trips must be exact.

import { describe, expect, test } from "bun:test"
import { displayLabel, makeFileId, parseFileId } from "../src/schema"

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
