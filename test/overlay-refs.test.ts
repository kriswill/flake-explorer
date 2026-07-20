import { expect, test } from "bun:test"
import { scanOverlayDefs } from "../src/extract/overlay-refs"

const scan = (files: Record<string, string>) =>
  scanOverlayDefs(
    Object.keys(files),
    async (p) => {
      const text = files[p]
      if (text === undefined) throw new Error("missing")
      return text
    },
    (p) => `self:${p}`,
  )

test("attr-path form: overlays.<name> = and flake.overlays.<name> =", async () => {
  const defs = await scan({
    "flake.nix": `{
      outputs = { self, ... }: {
        overlays.default = final: prev: { };
        overlays.dev-tools = final: prev: { };
      };
    }`,
    "parts/overlays.nix": `{
      flake.overlays.extra = final: prev: { hello = prev.hello; };
    }`,
  })
  expect(defs).toEqual([
    { name: "default", file: "self:flake.nix" },
    { name: "dev-tools", file: "self:flake.nix" },
    { name: "extra", file: "self:parts/overlays.nix" },
  ])
})

test("block form: flake.overlays = { … } entries, imports resolved to their file", async () => {
  // The dotfiles shape: an attach file whose entries import per-overlay files.
  const defs = await scan({
    "modules/overlays.nix": `{
      flake.overlays = {
        kitten = import ../overlays/kitten.nix;
        direnv = import ../overlays/direnv.nix; # trailing comment
        inline = final: prev: { hello = prev.hello; };
      };
    }`,
    "overlays/kitten.nix": "final: prev: { }",
    "overlays/direnv.nix": "final: prev: { }",
  })
  expect(defs).toEqual([
    { name: "kitten", file: "self:overlays/kitten.nix" },
    { name: "direnv", file: "self:overlays/direnv.nix" },
    // Unresolvable rhs falls back to the attach file itself.
    { name: "inline", file: "self:modules/overlays.nix" },
  ])
})

test("attr form with an import rhs also resolves to the imported file", async () => {
  const defs = await scan({
    "flake.nix": "{ overlays.default = import ./overlays/default.nix; }",
    "overlays/default.nix": "final: prev: { }",
  })
  expect(defs).toEqual([{ name: "default", file: "self:overlays/default.nix" }])
})

test("usages are not definitions: applied overlay lists and dotted prefixes stay out", async () => {
  const defs = await scan({
    "modules/nixpkgs.nix": `{
      nixpkgs.overlays = [
        inputs.rust-overlay.overlays.default
        (import ../overlays)
      ];
      config = lib.mkIf (config.overlays.default == null) { };
    }`,
  })
  expect(defs).toEqual([])
})

test("nested attrsets inside a block entry do not leak fake entries", async () => {
  const defs = await scan({
    "flake.nix": `{
      flake.overlays = {
        big = final: prev: {
          fake = prev.fake;
          deeper = { alsoFake = 1; };
        };
      };
    }`,
  })
  expect(defs).toEqual([{ name: "big", file: "self:flake.nix" }])
})

test("dedupes per site, keeps distinct files; unreadable files are skipped", async () => {
  const defs = await scan({
    "a.nix": `{
      overlays.default = final: prev: { };
      overlays.default = final: prev: { }; # re-defined in the same file
    }`,
    "b.nix": "overlays.default = final: prev: { };",
  })
  expect(defs).toEqual([
    { name: "default", file: "self:a.nix" },
    { name: "default", file: "self:b.nix" },
  ])

  const withMissing = await scanOverlayDefs(
    ["gone.nix"],
    async () => {
      throw new Error("io")
    },
    (p) => p,
  )
  expect(withMissing).toEqual([])
})
