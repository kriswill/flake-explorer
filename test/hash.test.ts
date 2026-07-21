import { describe, expect, test } from "bun:test"
import {
  decodeHash,
  encodeHash,
  type Filters,
  type Selection,
  sameSelection,
  type ViewState,
} from "../app/lib/hash"

/** All-default filters with the given overrides — one place to touch when a filter is added. */
const filters = (over: Partial<Filters> = {}): Filters => ({
  q: "",
  all: false,
  line: null,
  contrib: false,
  ...over,
})

const roundTrip = (sel: Selection | null, over: Partial<Filters> = {}): ViewState =>
  decodeHash(`#${encodeHash({ sel, filters: filters(over) })}`)

describe("hash codec", () => {
  test("round-trips every selection kind", () => {
    const cases: Selection[] = [
      { kind: "output", path: ["packages", "x86_64-linux", "flake-explorer"] },
      { kind: "config", configId: "nixos/nebula" },
      { kind: "module", configId: "darwin/k", moduleId: "self:modules/darwin/git.nix" },
      { kind: "option", configId: "nixos/nebula", loc: ["programs", "zsh", "histSize"] },
      { kind: "file", fileId: "input:sops-nix:modules/sops/default.nix" },
      { kind: "input", name: "home-manager/nixpkgs" },
      { kind: "diff", a: "nixos/nebula", b: "darwin/mini" },
    ]
    for (const sel of cases) {
      expect(roundTrip(sel).sel).toEqual(sel)
    }
  })

  test("round-trips filters", () => {
    const v = roundTrip(
      { kind: "config", configId: "nixos/nebula" },
      { q: "nginx & friends?", all: true, contrib: true },
    )
    expect(v.filters).toEqual(filters({ q: "nginx & friends?", all: true, contrib: true }))
  })

  test("the ?L= line anchor round-trips; junk and zero decode to null", () => {
    const sel: Selection = { kind: "file", fileId: "self:modules/zsh.nix" }
    expect(roundTrip(sel, { line: 108 }).filters.line).toBe(108)
    expect(encodeHash({ sel, filters: filters({ line: 108 }) })).toBe(
      "/f/self:modules%2Fzsh.nix?L=108",
    )
    expect(decodeHash("#/f/x?L=abc").filters.line).toBeNull()
    expect(decodeHash("#/f/x?L=-3").filters.line).toBeNull()
    expect(decodeHash("#/f/x?L=0").filters.line).toBeNull()
    // Absent line writes no param at all.
    expect(encodeHash({ sel, filters: filters() })).toBe("/f/self:modules%2Fzsh.nix")
  })

  test("output attr names containing dots round-trip", () => {
    // '.' separates output path segments — quoted Nix attrs may contain it
    // (legacyPackages.x86_64-linux."python3.12").
    const sel: Selection = {
      kind: "output",
      path: ["legacyPackages", "x86_64-linux", "python3.12"],
    }
    expect(roundTrip(sel).sel).toEqual(sel)
  })

  test("ids containing slashes and percents survive", () => {
    const sel: Selection = { kind: "file", fileId: "self:flakes/100%/weird?.nix" }
    expect(roundTrip(sel).sel).toEqual(sel)
  })

  test("option loc segments containing dots round-trip", () => {
    // Quoted Nix attrs may contain '.': environment.etc."resolv.conf".text.
    const sel: Selection = {
      kind: "option",
      configId: "nixos/nebula",
      loc: ["environment", "etc", "resolv.conf", "text"],
    }
    expect(roundTrip(sel).sel).toEqual(sel)
  })

  test("option URLs stay readable for typical locs", () => {
    const hash = encodeHash({
      sel: { kind: "option", configId: "nixos/nebula", loc: ["programs", "zsh", "histSize"] },
      filters: filters(),
    })
    expect(hash).toBe("/c/nixos%2Fnebula/opt/programs.zsh.histSize")
  })

  test("the contributing-files toggle round-trips as ?contrib=1", () => {
    const sel: Selection = { kind: "config", configId: "nixos/nebula" }
    expect(encodeHash({ sel, filters: filters({ contrib: true }) })).toBe(
      "/c/nixos%2Fnebula?contrib=1",
    )
    expect(decodeHash("#/c/x?contrib=1").filters.contrib).toBe(true)
    expect(decodeHash("#/c/x").filters.contrib).toBe(false)
  })

  test("a diff URL stays readable and needs both sides", () => {
    expect(
      encodeHash({
        sel: { kind: "diff", a: "nixos/nebula", b: "darwin/mini" },
        filters: filters(),
      }),
    ).toBe("/diff/nixos%2Fnebula/darwin%2Fmini")
    // A half-written diff link is not a selection.
    expect(decodeHash("#/diff/nixos%2Fnebula").sel).toBeNull()
  })

  test("hand-typed raw slashes in single-id links converge with the encoded form", () => {
    // The encoder escapes '/' as %2F, so the app's own links keep the id in one
    // segment; a human writing the link by hand leaves the slash raw. Both must
    // resolve to the same selection instead of truncating at the first slash.
    for (const raw of ["#/f/self:pkgs/rtk.nix", "#/f/self:pkgs%2Frtk.nix"]) {
      expect(decodeHash(raw).sel).toEqual({ kind: "file", fileId: "self:pkgs/rtk.nix" })
    }
    expect(decodeHash("#/i/home-manager/nixpkgs").sel).toEqual({
      kind: "input",
      name: "home-manager/nixpkgs",
    })
    expect(decodeHash("#/c/nixos/nebula").sel).toEqual({ kind: "config", configId: "nixos/nebula" })
    // Multi-arg config routes still treat '/' as a real separator.
    expect(decodeHash("#/c/nixos%2Fnebula/m/self:foo.nix").sel).toEqual({
      kind: "module",
      configId: "nixos/nebula",
      moduleId: "self:foo.nix",
    })
  })

  test("empty and garbage hashes decode to null selection", () => {
    expect(decodeHash("").sel).toBeNull()
    expect(decodeHash("#").sel).toBeNull()
    expect(decodeHash("#/x/y").sel).toBeNull()
    expect(decodeHash("#/f/%zz").sel).toEqual({ kind: "file", fileId: "%zz" })
  })

  test("sameSelection distinguishes filter-only changes", () => {
    const a: Selection = { kind: "module", configId: "nixos/nebula", moduleId: "m" }
    expect(sameSelection(a, { ...a })).toBe(true)
    expect(sameSelection(a, { kind: "config", configId: "nixos/nebula" })).toBe(false)
    expect(sameSelection(null, null)).toBe(true)
    expect(sameSelection(a, null)).toBe(false)
  })
})
