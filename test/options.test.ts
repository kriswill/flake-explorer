import { describe, expect, test } from "bun:test"
import { buildFileIndex, errLine, splitVia, toEntry, unwrap } from "../src/extract/options"
import type { RawOption } from "../src/extract/run-nix"
import { type OptionEntry, PRIO } from "../src/schema"

const entry = (over: Partial<OptionEntry>): OptionEntry => ({
  loc: ["x"],
  readOnly: false,
  isDefined: true,
  customized: false,
  declarations: [],
  definitions: [],
  ...over,
})

describe("buildFileIndex", () => {
  test("defines counts only customized definitions; declares counts all", () => {
    const options = [
      entry({
        loc: ["a"],
        customized: true,
        declarations: [{ file: "/f/decl.nix" }],
        definitions: [{ file: "/f/def.nix", value: 1 }],
      }),
      entry({
        loc: ["b"],
        customized: false, // defaulted — its definition points at the declaring module
        declarations: [{ file: "/f/decl.nix" }],
        definitions: [{ file: "/f/decl.nix", value: 2 }],
      }),
    ]
    const idx = buildFileIndex(options)
    expect(idx["/f/def.nix"]).toEqual({ defines: [0], declares: [] })
    expect(idx["/f/decl.nix"]).toEqual({ defines: [], declares: [0, 1] })
  })

  test("an option defined twice by the same file is indexed once", () => {
    const options = [
      entry({
        loc: ["environment", "profiles"],
        customized: true,
        declarations: [{ file: "/f/decl.nix" }, { file: "/f/decl.nix" }],
        definitions: [
          { file: "/f/env.nix", value: ["a"] },
          { file: "/f/env.nix", value: ["b"] },
        ],
      }),
    ]
    const idx = buildFileIndex(options)
    expect(idx["/f/env.nix"]).toEqual({ defines: [0], declares: [] })
    expect(idx["/f/decl.nix"]).toEqual({ defines: [], declares: [0] })
  })
})

describe("splitVia", () => {
  test("strips the module-system provenance suffix", () => {
    expect(splitVia("foo.nix, via option a.b")).toEqual(["foo.nix", "a.b"])
  })

  test("plain paths pass through with no via", () => {
    expect(splitVia("/nix/store/x/foo.nix")).toEqual(["/nix/store/x/foo.nix", undefined])
  })
})

describe("unwrap", () => {
  test("ok carries the value through, including falsy ones", () => {
    expect(unwrap({ ok: 42 })).toEqual({ value: 42 })
    expect(unwrap({ ok: null })).toEqual({ value: null })
    expect(unwrap({ ok: false })).toEqual({ value: false })
  })

  test("err becomes valueError", () => {
    expect(unwrap({ err: true })).toEqual({ valueError: true })
  })

  test("null (absent) yields nothing; skipped is flagged", () => {
    expect(unwrap(null)).toEqual({})
    expect(unwrap({ skipped: true })).toEqual({ valueSkipped: true })
  })
})

describe("errLine", () => {
  test("last substantive error: line wins; bare error: prefixes are skipped", () => {
    const trace = [
      "error:",
      "       … while evaluating the attribute 'config'",
      "error: cannot coerce a set to a string",
      "error:",
      "error: attribute 'foo' missing",
      "       at /nix/store/x/mod.nix:3:5",
    ].join("\n")
    expect(errLine(trace)).toBe("error: attribute 'foo' missing")
  })

  test("falls back to the first line when no error: lines exist", () => {
    expect(errLine("timed out after 600000ms\nsecond line")).toBe("timed out after 600000ms")
  })
})

// mini-flake.test.ts covers `customized` end-to-end only when nix is on PATH;
// these unit tests are what runs inside the sandboxed checks.test.
describe("toEntry", () => {
  const raw = (over: Partial<RawOption>): RawOption => ({
    loc: ["x"],
    type: null,
    description: null,
    readOnly: false,
    isDefined: true,
    highestPrio: 100,
    defaultText: null,
    default: null,
    value: null,
    declarations: [],
    definitions: [],
    ...over,
  })

  test("customized is strict: only defined options beating optionDefault prio", () => {
    const at = (over: Partial<RawOption>) => toEntry(raw(over)).customized
    expect(at({ highestPrio: PRIO.optionDefault })).toBe(false) // 1500: strict <
    expect(at({ highestPrio: PRIO.optionDefault - 1 })).toBe(true) // 1499
    expect(at({ highestPrio: null })).toBe(false)
    expect(at({ isDefined: false, highestPrio: 100 })).toBe(false)
  })

  test("declarations map to file objects; via splits into a clean file + provenance", () => {
    const e = toEntry(
      raw({
        declarations: [
          { file: "/f/decl.nix", line: 12, column: 3 },
          { file: "/f/via.nix, via option flake.modules.nixos.demo", line: null, column: null },
        ],
        definitions: [
          { file: "/f/def.nix, via option a.b", value: { ok: 1 } },
          { file: "/f/bad.nix", value: { err: true } },
          { file: "/f/skip.nix", value: { skipped: true } },
          { file: "/f/names.nix", value: { names: ["hello-2.12"] } },
        ],
      }),
    )
    expect(e.declarations).toEqual([
      { file: "/f/decl.nix", line: 12, column: 3 },
      { file: "/f/via.nix", via: "flake.modules.nixos.demo" },
    ])
    expect(e.definitions).toEqual([
      { file: "/f/def.nix", via: "a.b", value: 1 },
      { file: "/f/bad.nix", valueError: true },
      { file: "/f/skip.nix", valueSkipped: true },
      { file: "/f/names.nix", valueSkipped: true, valueNames: ["hello-2.12"] },
    ])
  })

  test("declarations without positions carry no line/column keys", () => {
    const e = toEntry(raw({ declarations: [{ file: "/f/decl.nix", line: null, column: null }] }))
    expect(e.declarations).toEqual([{ file: "/f/decl.nix" }])
    expect("line" in e.declarations[0]!).toBe(false)
  })

  test("a definition's {mkOverride, content} envelope lifts into prio + value", () => {
    const e = toEntry(
      raw({
        definitions: [
          { file: "/f/force.nix", value: { ok: { mkOverride: PRIO.mkForce, content: "forced" } } },
          { file: "/f/soft.nix", value: { ok: { mkOverride: PRIO.mkDefault, content: false } } },
          { file: "/f/plain.nix", value: { ok: "plain" } },
        ],
      }),
    )
    expect(e.definitions).toEqual([
      { file: "/f/force.nix", prio: PRIO.mkForce, value: "forced" },
      { file: "/f/soft.nix", prio: PRIO.mkDefault, value: false },
      { file: "/f/plain.nix", value: "plain" },
    ])
  })

  test("mkOverride lifting is shape-strict: extra keys or non-numeric prio stay as values", () => {
    const notEnvelope = { mkOverride: 50, content: 1, extra: true }
    const nullPrio = { mkOverride: null, content: "x" }
    const e = toEntry(
      raw({
        definitions: [
          { file: "/f/a.nix", value: { ok: notEnvelope } },
          { file: "/f/b.nix", value: { ok: nullPrio } },
        ],
      }),
    )
    // Extra keys: not scrub's envelope — passed through untouched.
    expect(e.definitions[0]).toEqual({ file: "/f/a.nix", value: notEnvelope })
    // Null priority (scrub's `v.priority or null`): content lifted, no prio.
    expect(e.definitions[1]).toEqual({ file: "/f/b.nix", value: "x" })
  })

  test("value skip flag threads through to the entry", () => {
    expect(toEntry(raw({ value: { skipped: true } })).valueSkipped).toBe(true)
    expect(toEntry(raw({ value: { ok: 1 } })).valueSkipped).toBeUndefined()
  })

  test("null raw fields become undefined; envelopes fill value/default", () => {
    const e = toEntry(
      raw({
        type: "boolean",
        description: "d",
        value: { ok: true },
        default: { ok: false },
        defaultText: "lib.mkDefault false",
      }),
    )
    expect(e.type).toBe("boolean")
    expect(e.description).toBe("d")
    expect(e.value).toBe(true)
    expect(e.default).toBe(false)
    expect(e.defaultText).toBe("lib.mkDefault false")
    const bare = toEntry(raw({}))
    expect(bare.type).toBeUndefined()
    expect(bare.description).toBeUndefined()
    expect(bare.value).toBeUndefined()
    expect(bare.valueError).toBeUndefined()
  })
})
