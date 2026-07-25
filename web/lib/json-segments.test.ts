// jsonSegments: the syntax-colored JSON renderer behind OptionRow's expanded
// value and OptionDetail's value blocks. Its documented contract is that the
// concatenated segment text matches JSON.stringify(v, null, 2) exactly — so
// that is what the battery below asserts, value by value.

import { describe, expect, test } from "bun:test"
import { jsonSegments } from "../app/lib/json-segments"

const render = (v: unknown) =>
  jsonSegments(v, "")
    .map((s) => s.text)
    .join("")

const clsOf = (v: unknown) =>
  jsonSegments(v, "")
    .filter((s) => s.cls)
    .map((s) => `${s.cls}:${s.text}`)

describe("layout matches JSON.stringify(v, null, 2)", () => {
  const cases: [string, unknown][] = [
    ["null", null],
    ["true", true],
    ["false", false],
    ["integer", 42],
    ["negative float", -3.5],
    ["string", "hello"],
    ["string needing escapes", 'a "quoted" \\ back\nslash'],
    ["empty array", []],
    ["empty object", {}],
    ["flat array", [1, "two", false, null]],
    ["flat object", { a: 1, b: "two" }],
    ["nested object", { outer: { inner: [1, { deep: true }] } }],
    ["array of objects", [{ a: 1 }, { b: [2, 3] }]],
    ["object with empty containers", { arr: [], obj: {}, n: null }],
    ["deeply nested", { a: { b: { c: { d: [1, [2, [3]]] } } } }],
    ["key needing escapes", { 'weird "key"': 1 }],
    ["unicode", { emoji: "→ ✓", nix: "«drv:hello»" }],
  ]
  for (const [name, value] of cases) {
    test(name, () => {
      expect(render(value)).toBe(JSON.stringify(value, null, 2))
    })
  }
})

describe("values JSON.stringify treats specially", () => {
  // Extractor output is JSON, so these can't occur in practice — but the
  // documented invariant is unconditional, and a caller passing a live JS
  // object should not get markup that claims to be JSON and isn't.
  test("undefined inside an array renders as null, like JSON.stringify", () => {
    expect(render([1, undefined, 2])).toBe(JSON.stringify([1, undefined, 2], null, 2))
  })

  test("undefined-valued object keys are omitted, like JSON.stringify", () => {
    expect(render({ a: 1, b: undefined })).toBe(JSON.stringify({ a: 1, b: undefined }, null, 2))
  })

  test("an object whose keys are all undefined renders as {}", () => {
    expect(render({ a: undefined })).toBe(JSON.stringify({ a: undefined }, null, 2))
  })

  test("NaN and Infinity render as null, like JSON.stringify", () => {
    expect(render(Number.NaN)).toBe(JSON.stringify(Number.NaN, null, 2))
    expect(render(Number.POSITIVE_INFINITY)).toBe(JSON.stringify(Number.POSITIVE_INFINITY, null, 2))
  })
})

describe("types JSON cannot represent at all", () => {
  test("a bigint renders its digits instead of throwing the way JSON.stringify does", () => {
    // The one place the JSON.stringify invariant cannot be honored: stringify
    // throws on bigint. A value view must still render something rather than
    // take the pane down, so the fallback prints the value.
    expect(() => JSON.stringify(10n)).toThrow()
    expect(render(10n)).toBe("10")
  })

  test("a top-level undefined renders as the word, matching how callers guard it", () => {
    // OptionRow/OptionDetail check `value !== undefined` before calling, so
    // this only documents the bare fallback.
    expect(render(undefined)).toBe("undefined")
  })
})

describe("token classes", () => {
  test("each scalar kind gets its own class", () => {
    expect(clsOf(null)).toEqual(["tok-atom:null"])
    expect(clsOf(true)).toEqual(["tok-atom:true"])
    expect(clsOf(7)).toEqual(["tok-number:7"])
    expect(clsOf("s")).toEqual(['tok-string:"s"'])
  })

  test("object keys are classed apart from string values", () => {
    expect(clsOf({ k: "v" })).toEqual(['tok-key:"k"', 'tok-string:"v"'])
  })

  test("structural punctuation carries no class", () => {
    const segs = jsonSegments([1], "")
    expect(segs.filter((s) => !s.cls).map((s) => s.text)).toEqual(["[\n", "  ", "\n", "]"])
  })
})

describe("indent parameter", () => {
  test("nested renders are offset by the caller's indent", () => {
    // How OptionDetail renders a value already sitting inside a block.
    expect(
      jsonSegments({ a: 1 }, "  ")
        .map((s) => s.text)
        .join(""),
    ).toBe('{\n    "a": 1\n  }')
  })
})
