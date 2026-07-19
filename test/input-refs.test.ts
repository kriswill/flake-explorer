import { describe, expect, test } from "bun:test"
import { canonicalInputNames, scanInputRefs } from "../src/extract/input-refs"

// scanInputRefs takes read() and idOf() as parameters, so it runs against an
// in-memory fixture map — no nix, no filesystem (mini-flake.test.ts covers
// the real scan end-to-end, but only when nix is on PATH).
const scan = (files: Record<string, string>, names: Record<string, string>) =>
  scanInputRefs(
    Object.keys(files),
    new Map(Object.entries(names)),
    (p) => {
      const text = files[p]
      return text === undefined
        ? Promise.reject(new Error(`no such file: ${p}`))
        : Promise.resolve(text)
    },
    (p) => `id:${p}`,
  )

const KNOWN = { "sops-nix": "sops-nix", nixpkgs: "nixpkgs" }

describe("scanInputRefs", () => {
  test("matches inputs.<name> and flake-parts' inputs'.<name>", async () => {
    const refs = await scan(
      {
        "a.nix": "{ imports = [ inputs.sops-nix.nixosModules.sops ]; }",
        "b.nix":
          "perSystem = { inputs', ... }: { packages.x = inputs'.nixpkgs.legacyPackages.hello; };",
      },
      KNOWN,
    )
    expect(refs).toEqual([
      { file: "id:a.nix", input: "sops-nix" },
      { file: "id:b.nix", input: "nixpkgs" },
    ])
  })

  test("dedupes repeated references within one file", async () => {
    const refs = await scan(
      { "a.nix": "inputs.nixpkgs.lib // inputs.nixpkgs.legacyPackages" },
      KNOWN,
    )
    expect(refs).toEqual([{ file: "id:a.nix", input: "nixpkgs" }])
  })

  test("unknown names are dropped (inputs.self, locals named inputs)", async () => {
    const refs = await scan({ "a.nix": "inputs.self.outPath + inputs.notAnInput.x" }, KNOWN)
    expect(refs).toEqual([])
  })

  test("follows-aliases resolve to the canonical input name", async () => {
    const refs = await scan(
      { "a.nix": "inputs.stable.legacyPackages" },
      { nixpkgs: "nixpkgs", stable: "nixpkgs" },
    )
    expect(refs).toEqual([{ file: "id:a.nix", input: "nixpkgs" }])
  })

  test("only the first attr segment counts — inputs.nixpkgs.url is nixpkgs, not url", async () => {
    const refs = await scan({ "flake.nix": 'inputs.nixpkgs.url = "github:NixOS/nixpkgs";' }, KNOWN)
    expect(refs).toEqual([{ file: "id:flake.nix", input: "nixpkgs" }])
  })

  test("a file whose read() rejects contributes nothing, siblings still do", async () => {
    const files = {
      "broken.nix": "inputs.nixpkgs.lib",
      "fine.nix": "inputs.nixpkgs.lib",
    }
    const refs = await scanInputRefs(
      Object.keys(files),
      new Map(Object.entries(KNOWN)),
      (p) =>
        p === "broken.nix"
          ? Promise.reject(new Error("boom"))
          : Promise.resolve(files[p as keyof typeof files]),
      (p) => `id:${p}`,
    )
    expect(refs).toEqual([{ file: "id:fine.nix", input: "nixpkgs" }])
  })

  test("word boundary: myinputs.nixpkgs does not match; config.inputs.nixpkgs does", async () => {
    const refs = await scan(
      { "a.nix": "myinputs.nixpkgs.x", "b.nix": "config.inputs.nixpkgs.x" },
      KNOWN,
    )
    // False positives on unrelated `.inputs.` attrs are the accepted cost of
    // a regex scan (harmless in a visualization); missing real refs is not.
    expect(refs).toEqual([{ file: "id:b.nix", input: "nixpkgs" }])
  })
})

describe("canonicalInputNames", () => {
  test("maps names and aliases to the canonical entry; skips transitive inputs", () => {
    const map = canonicalInputNames({
      nixpkgs: { name: "nixpkgs", aliases: ["stable", "unstable"] },
      "sops-nix": { name: "sops-nix" },
      "sops-nix/nixpkgs": { name: "sops-nix/nixpkgs", transitive: true },
    })
    expect(map.get("nixpkgs")).toBe("nixpkgs")
    expect(map.get("stable")).toBe("nixpkgs")
    expect(map.get("unstable")).toBe("nixpkgs")
    expect(map.get("sops-nix")).toBe("sops-nix")
    expect(map.has("sops-nix/nixpkgs")).toBe(false)
  })
})
