// diffConfigs: pure option-level comparison of two loaded configurations.

import { describe, expect, test } from "bun:test"
import { cellText, type DiffSide, diffConfigs, diffCounts } from "../app/lib/diff"
import { buildConfigIndexes, buildFlakeIndexes } from "../app/lib/indexes"
import type { ConfigData, OptionEntry } from "../src/schema"
import { fixtureManifest, opt, SELF } from "./fixtures/data"

const manifest = fixtureManifest()
const fx = buildFlakeIndexes(manifest)

/** A loaded-config side built from a bare option list. */
function side(id: string, options: OptionEntry[]): DiffSide {
  const data: ConfigData = { version: 1, id, options, fileIndex: {} }
  return { data, indexes: buildConfigIndexes(manifest, data, fx) }
}

const set = (loc: string, over: Partial<OptionEntry> = {}) =>
  opt(loc.split("."), {
    customized: true,
    highestPrio: 100,
    definitions: [{ file: `${SELF}/modules/a.nix` }],
    ...over,
  })

const defaulted = (loc: string, value: unknown) =>
  opt(loc.split("."), { customized: false, highestPrio: 1500, value })

describe("diffConfigs", () => {
  test("classifies only-a, only-b, differs, and equal", () => {
    const a = side("nixos/a", [
      set("shared.same", { value: 1 }),
      set("shared.differs", { value: "alpha" }),
      set("a.only", { value: true }),
    ])
    const b = side("nixos/b", [
      set("shared.same", { value: 1 }),
      set("shared.differs", { value: "beta" }),
      set("b.only", { value: true }),
    ])
    const rows = diffConfigs(a, b)
    expect(rows.map((r) => [r.loc, r.kind])).toEqual([
      ["a.only", "only-a"],
      ["b.only", "only-b"],
      ["shared.differs", "differs"],
      ["shared.same", "equal"],
    ])
    expect(diffCounts(rows)).toMatchObject({
      "only-a": 1,
      "only-b": 1,
      differs: 1,
      equal: 1,
      incomparable: 0,
    })
  })

  test("an option present but merely defaulted on one side counts as only-<other>", () => {
    const a = side("nixos/a", [set("x.y", { value: 2 })])
    const b = side("nixos/b", [defaulted("x.y", 1)])
    const rows = diffConfigs(a, b)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ loc: "x.y", kind: "only-a" })
    // The defaulted entry still rides along so the cell can show its value.
    expect(rows[0]!.b?.customized).toBe(false)
  })

  test("options neither side customizes are omitted entirely", () => {
    const a = side("nixos/a", [defaulted("noise.one", 1), set("real", { value: 1 })])
    const b = side("nixos/b", [defaulted("noise.one", 1)])
    expect(diffConfigs(a, b).map((r) => r.loc)).toEqual(["real"])
  })

  test("package-typed names compare even though the values are skipped", () => {
    const names = (v: string[]) => ({ valueSkipped: true as const, valueNames: v })
    const a = side("nixos/a", [
      set("environment.systemPackages", names(["hello-2.12", "rg-14.1"])),
      set("same.pkgs", names(["hello-2.12"])),
    ])
    const b = side("nixos/b", [
      set("environment.systemPackages", names(["hello-2.12"])),
      set("same.pkgs", names(["hello-2.12"])),
    ])
    const byLoc = new Map(diffConfigs(a, b).map((r) => [r.loc, r.kind]))
    expect(byLoc.get("environment.systemPackages")).toBe("differs")
    expect(byLoc.get("same.pkgs")).toBe("equal")
  })

  test("skipped or errored values with no names are incomparable", () => {
    const a = side("nixos/a", [
      set("skip.me", { valueSkipped: true }),
      set("err.me", { valueError: true }),
    ])
    const b = side("nixos/b", [set("skip.me", { value: 1 }), set("err.me", { value: 1 })])
    expect(diffConfigs(a, b).map((r) => r.kind)).toEqual(["incomparable", "incomparable"])
  })

  test("undefined and null values do not collide", () => {
    const a = side("nixos/a", [set("v", { value: null })])
    const b = side("nixos/b", [set("v", {})]) // no value key at all
    // Both render as null — treated as equal, deliberately: an absent value
    // on a customized option carries no more information than an explicit null.
    expect(diffConfigs(a, b)[0]!.kind).toBe("equal")
  })

  test("rows sort by loc regardless of input order", () => {
    const a = side("nixos/a", [set("z.opt"), set("a.opt")])
    const b = side("nixos/b", [])
    expect(diffConfigs(a, b).map((r) => r.loc)).toEqual(["a.opt", "z.opt"])
  })
})

describe("cellText", () => {
  test("renders each value state distinctly", () => {
    expect(cellText(undefined)).toBe("—")
    expect(cellText(defaulted("x", 1))).toBe("(default)")
    expect(cellText(set("x", { value: { a: 1 } }))).toBe('{"a":1}')
    expect(cellText(set("x", { valueSkipped: true }))).toBe("(value skipped)")
    expect(cellText(set("x", { valueError: true }))).toBe("⚠ failed to evaluate")
    expect(cellText(set("x", { valueSkipped: true, valueNames: ["hello-2.12"] }))).toBe(
      "hello-2.12",
    )
    expect(cellText(set("x", { valueSkipped: true, valueNames: [] }))).toBe("(no packages)")
  })
})
