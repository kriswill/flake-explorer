// Pure unit tests for lib/segments.ts: tree-sitter token classing and the
// line-segmentation union of token/ref interval sets shared by FileDetail
// and InputDetail (via SourceView).

import { describe, expect, test } from "bun:test"
import { segmentLines, tokenClass } from "../app/lib/segments"
import type { TokenRun } from "../src/schema"

describe("tokenClass", () => {
  test("maps known tree-sitter captures to their CSS class", () => {
    expect(tokenClass("comment")).toBe("tok-comment")
    expect(tokenClass("keyword")).toBe("tok-keyword")
    expect(tokenClass("number")).toBe("tok-number")
    expect(tokenClass("function")).toBe("tok-function")
    expect(tokenClass("function.builtin")).toBe("tok-builtin")
    expect(tokenClass("variable.builtin")).toBe("tok-builtin")
    expect(tokenClass("property")).toBe("tok-property")
    expect(tokenClass("escape")).toBe("tok-string")
  })

  test("any string.* capture falls back to tok-string", () => {
    expect(tokenClass("string")).toBe("tok-string")
    expect(tokenClass("string.special.path")).toBe("tok-string")
  })

  test("unknown or absent captures render unstyled", () => {
    expect(tokenClass("punctuation")).toBeUndefined()
    expect(tokenClass(undefined)).toBeUndefined()
  })
})

describe("segmentLines", () => {
  test("plain text with no tokens/refs yields one unstyled segment per line", () => {
    const lines = segmentLines("a = 1;\nb = 2;", [])
    expect(lines).toEqual([[{ text: "a = 1;", ref: undefined, cls: undefined }], [{ text: "b = 2;", ref: undefined, cls: undefined }]])
  })

  test("an empty line still yields one (empty) segment, not zero", () => {
    const lines = segmentLines("a;\n\nb;", [])
    expect(lines[1]).toEqual([{ text: "" }])
  })

  test("token runs split a line and carry the mapped class", () => {
    const tokens: TokenRun[] = [{ start: 0, end: 8, name: "keyword" }]
    const lines = segmentLines("let x = 1;", tokens)
    expect(lines[0]).toEqual([
      { text: "let x = ", ref: undefined, cls: "tok-keyword" },
      { text: "1;", ref: undefined, cls: undefined },
    ])
  })

  test("a token spanning multiple lines is clipped to each line's bounds", () => {
    // start=0 end=13 covers "/* c\nomment *" (13 chars) — the trailing "/" falls outside.
    const tokens: TokenRun[] = [{ start: 0, end: 13, name: "comment" }]
    const lines = segmentLines("/* c\nomment */", tokens)
    expect(lines[0]).toEqual([{ text: "/* c", ref: undefined, cls: "tok-comment" }])
    expect(lines[1]).toEqual([
      { text: "omment *", ref: undefined, cls: "tok-comment" },
      { text: "/", ref: undefined, cls: undefined },
    ])
  })

  test("refsForLine intervals attach a ref value independent of token boundaries", () => {
    const lines = segmentLines("import ./foo.nix", [], (line) => {
      const idx = line.indexOf("./foo.nix")
      return idx < 0 ? [] : [{ start: idx, end: idx + "./foo.nix".length, value: "self:foo.nix" }]
    })
    expect(lines[0]).toEqual([
      { text: "import ", ref: undefined, cls: undefined },
      { text: "./foo.nix", ref: "self:foo.nix", cls: undefined },
    ])
  })

  test("overlapping ref and token intervals both apply to the same segment", () => {
    const tokens: TokenRun[] = [{ start: 0, end: 9, name: "string" }]
    const lines = segmentLines('"./foo.nix"', tokens, () => [{ start: 1, end: 10, value: "self:foo.nix" }])
    // bounds 0,1,9,10,11 -> [0,1) string-only, [1,9) string+ref, [9,10) ref-only, [10,11) plain
    expect(lines[0]).toEqual([
      { text: '"', ref: undefined, cls: "tok-string" },
      { text: "./foo.ni", ref: "self:foo.nix", cls: "tok-string" },
      { text: "x", ref: "self:foo.nix", cls: undefined },
      { text: '"', ref: undefined, cls: undefined },
    ])
  })

  test("an unresolvable ref match still splits the line, with ref undefined", () => {
    const lines = segmentLines("import ./missing.nix", [], (line) => {
      const idx = line.indexOf("./missing.nix")
      return [{ start: idx, end: idx + "./missing.nix".length, value: undefined }]
    })
    expect(lines[0].map((s) => s.text)).toEqual(["import ", "./missing.nix"])
    expect(lines[0][1]!.ref).toBeUndefined()
  })
})
