import { describe, expect, test } from "bun:test"
import {
  decodeHash,
  encodeHash,
  type Selection,
  sameSelection,
  type ViewState,
} from "../app/lib/hash"

const roundTrip = (sel: Selection | null, q = "", all = false): ViewState =>
  decodeHash(`#${encodeHash({ sel, filters: { q, all } })}`)

describe("hash codec", () => {
  test("round-trips every selection kind", () => {
    const cases: Selection[] = [
      { kind: "output", path: ["packages", "x86_64-linux", "flake-explorer"] },
      { kind: "config", configId: "nixos/nebula" },
      { kind: "module", configId: "darwin/k", moduleId: "self:modules/darwin/git.nix" },
      { kind: "option", configId: "nixos/nebula", loc: ["programs", "zsh", "histSize"] },
      { kind: "file", fileId: "input:sops-nix:modules/sops/default.nix" },
      { kind: "input", name: "home-manager/nixpkgs" },
    ]
    for (const sel of cases) {
      expect(roundTrip(sel).sel).toEqual(sel)
    }
  })

  test("round-trips filters", () => {
    const v = roundTrip({ kind: "config", configId: "nixos/nebula" }, "nginx & friends?", true)
    expect(v.filters).toEqual({ q: "nginx & friends?", all: true })
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
      filters: { q: "", all: false },
    })
    expect(hash).toBe("/c/nixos%2Fnebula/opt/programs.zsh.histSize")
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
