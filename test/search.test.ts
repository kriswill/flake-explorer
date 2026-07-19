import { describe, expect, test } from "bun:test"
import { flatHits, type OptionSource, rankMatch, searchAll } from "../app/lib/search"
import type { Manifest } from "../src/schema"
import { fixtureConfig, fixtureManifest, opt } from "./fixtures/data"

const sourceOf = (configId: string, options = fixtureConfig().options): OptionSource => ({
  configId,
  options,
  locsLower: options.map((o) => o.loc.join(".").toLowerCase()),
})

describe("rankMatch", () => {
  test("exact > exact segment > segment prefix > substring > none", () => {
    expect(rankMatch("zsh", "zsh")).toBe(0)
    expect(rankMatch("programs.zsh.enable", "zsh")).toBe(1)
    expect(rankMatch("programs.zsh.histsize", "hist")).toBe(2)
    expect(rankMatch("programs.zsh.histsize", "istsi")).toBe(3)
    expect(rankMatch("programs.zsh.histsize", "nope")).toBeNull()
  })

  test("path segments split on slashes too", () => {
    expect(rankMatch("modules/nixos/zsh.nix", "nixos")).toBe(1)
    expect(rankMatch("modules/nixos/zsh.nix", "zsh")).toBe(1) // "zsh.nix" splits on the dot too
    expect(rankMatch("modules/nixos/zsh.nix", "zs")).toBe(2) // segment prefix
  })
})

describe("searchAll", () => {
  const manifest = fixtureManifest()

  test("finds options in loaded sources with setter/declarer detail", () => {
    const cats = searchAll("enable", manifest, [sourceOf("nixos/test")])
    const options = cats.find((c) => c.kind === "options")!
    expect(options.hits[0]).toMatchObject({
      label: "services.x.enable",
      detail: "nixos/test · set by a.nix",
      customized: true,
      sel: { kind: "option", configId: "nixos/test", loc: ["services", "x", "enable"] },
    })
  })

  test("non-customized options fall back to the declarer", () => {
    const cats = searchAll("port", manifest, [sourceOf("nixos/test")])
    const hit = cats.find((c) => c.kind === "options")!.hits[0]!
    expect(hit.detail).toBe("nixos/test · declared in b.nix")
    expect(hit.customized).toBe(false)
  })

  test("customized options outrank untouched ones at equal match quality", () => {
    const options = [
      opt(["services", "aaa"], {}),
      opt(["services", "bbb"], { customized: true, definitions: [{ file: "/f/x.nix" }] }),
    ]
    const cats = searchAll("services", manifest, [sourceOf("nixos/test", options)])
    expect(cats.find((c) => c.kind === "options")!.hits.map((h) => h.label)).toEqual([
      "services.bbb",
      "services.aaa",
    ])
  })

  test("packages, files, and inputs come from the manifest — no sources needed", () => {
    const cats = searchAll("hello", manifest, [])
    expect(cats.find((c) => c.kind === "packages")!.hits[0]).toMatchObject({
      label: "packages.x86_64-linux.hello",
      sel: { kind: "output", path: ["packages", "x86_64-linux", "hello"] },
    })

    const fileCats = searchAll("a.nix", manifest, [])
    expect(fileCats.find((c) => c.kind === "files")!.hits[0]).toMatchObject({
      sel: { kind: "file", fileId: "self:modules/a.nix" },
    })

    const inputCats = searchAll("sops", manifest, [])
    expect(inputCats.find((c) => c.kind === "inputs")!.hits[0]).toMatchObject({
      label: "sops-nix",
      sel: { kind: "input", name: "sops-nix" },
    })
  })

  test("input aliases match and are noted; transitive inputs are excluded", () => {
    const m: Manifest = {
      ...manifest,
      inputs: {
        nixpkgs: { name: "nixpkgs", nodeKey: "np", type: "github", aliases: ["stable"] },
        "sops-nix/nixpkgs": {
          name: "sops-nix/nixpkgs",
          nodeKey: "np2",
          type: "github",
          transitive: true,
        },
      },
    }
    const cats = searchAll("stable", m, [])
    const inputs = cats.find((c) => c.kind === "inputs")!
    expect(inputs.hits).toEqual([
      { label: "nixpkgs", detail: "aliases: stable", sel: { kind: "input", name: "nixpkgs" } },
    ])
    expect(searchAll("sops-nix/nixpkgs", m, [])).toEqual([])
  })

  test("caps each category and reports the uncapped total", () => {
    const options = Array.from({ length: 30 }, (_, i) => opt(["services", `svc${i}`, "enable"]))
    const cats = searchAll("services", manifest, [sourceOf("nixos/test", options)])
    const cat = cats.find((c) => c.kind === "options")!
    expect(cat.hits.length).toBe(20)
    expect(cat.total).toBe(30)
  })

  test("empty or whitespace query yields nothing", () => {
    expect(searchAll("", manifest, [sourceOf("nixos/test")])).toEqual([])
    expect(searchAll("   ", manifest, [sourceOf("nixos/test")])).toEqual([])
  })

  test("flatHits preserves category display order", () => {
    const cats = searchAll("x", manifest, [sourceOf("nixos/test")])
    const flat = flatHits(cats)
    expect(flat.length).toBe(cats.reduce((n, c) => n + c.hits.length, 0))
    expect(flat[0]).toBe(cats[0]!.hits[0]!)
  })
})
