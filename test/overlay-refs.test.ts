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
    // hello = prev.hello → override; empty bodies carry no attrs field.
    {
      name: "extra",
      file: "self:parts/overlays.nix",
      attrs: [{ name: "hello", kind: "override" }],
    },
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
    {
      name: "inline",
      file: "self:modules/overlays.nix",
      attrs: [{ name: "hello", kind: "override" }],
    },
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
  // `big` and `deeper` are the depth-1 attrs; `alsoFake` (nested) does not leak.
  expect(defs).toEqual([
    {
      name: "big",
      file: "self:flake.nix",
      attrs: [
        { name: "fake", kind: "override" },
        { name: "deeper", kind: "add" },
      ],
    },
  ])
})

test("override needs the SAME name from prev/super; prev under another name is an add", async () => {
  const defs = await scan({
    "flake.nix": `{
      overlays.default = final: prev: {
        rtk = prev.rtk.overrideAttrs (old: { });   # same name → override
        myPython = prev.python3;                     # aliases another pkg → add
        wrapped = prev.callPackage ./wrapped.nix {}; # builds fresh via prev → add
        pinned = prev.pinned // { x = 1; };          # merges same name → override
      };
    }`,
  })
  expect(defs).toEqual([
    {
      name: "default",
      file: "self:flake.nix",
      attrs: [
        { name: "rtk", kind: "override" },
        { name: "myPython", kind: "add" },
        { name: "wrapped", kind: "add" },
        { name: "pinned", kind: "override" },
      ],
    },
  ])
})

test("overlay body attrs: add vs override, and bodies read from the imported file", async () => {
  const defs = await scan({
    "flake.nix": `{
      overlays.default = final: prev: {
        freshPkg = final.callPackage ./pkg.nix { };
        patched = prev.patched.overrideAttrs (old: { doCheck = false; });
        pinned = prev.pinned;
      };
      overlays.viaImport = import ./overlays/big.nix;
    }`,
    // Imported body: whole file is the lambda; self/super naming + leading comment.
    "overlays/big.nix": `# an overlay
      self: super: {
        added = self.hello;
        bumped = super.bumped.override { withX = true; };
      }`,
  })
  expect(defs).toEqual([
    {
      name: "default",
      file: "self:flake.nix",
      attrs: [
        { name: "freshPkg", kind: "add" },
        { name: "patched", kind: "override" },
        { name: "pinned", kind: "override" },
      ],
    },
    {
      name: "viaImport",
      file: "self:overlays/big.nix",
      attrs: [
        { name: "added", kind: "add" },
        { name: "bumped", kind: "override" },
      ],
    },
  ])
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
