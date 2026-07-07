import { describe, expect, test } from "bun:test";
import { buildConfigIndexes, buildFlakeIndexes, resolveFile } from "../app/lib/indexes";
import type { ConfigData, Manifest, OptionEntry } from "../src/schema";

const SELF = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-source";
const SOPS = "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-source";
const NIXPKGS = "/nix/store/cccccccccccccccccccccccccccccccc-source";
const PATCHED = `/nix/store/dddddddddddddddddddddddddddddddd-${NIXPKGS.split("/").pop()}`;

const opt = (loc: string[], over: Partial<OptionEntry> = {}): OptionEntry => ({
  loc,
  internal: false,
  visible: true,
  readOnly: false,
  isDefined: true,
  customized: false,
  declarations: [],
  definitions: [],
  ...over,
});

const manifest: Manifest = {
  version: 1,
  generatedAt: "2026-07-06T00:00:00Z",
  extractor: "test",
  flake: { ref: "/etc/test", path: SELF },
  outputs: { kind: "attrset", children: {} },
  inputs: {
    "sops-nix": { name: "sops-nix", nodeKey: "sops-nix", type: "github", storePath: SOPS },
    nixpkgs: { name: "nixpkgs", nodeKey: "nixpkgs", type: "github", storePath: NIXPKGS },
  },
  files: [
    { id: "self:modules/a.nix", relPath: "modules/a.nix", origin: { kind: "self" }, storePath: `${SELF}/modules/a.nix` },
    { id: "self:modules/sub/b.nix", relPath: "modules/sub/b.nix", origin: { kind: "self" }, storePath: `${SELF}/modules/sub/b.nix` },
    { id: "self:lib/c.nix", relPath: "lib/c.nix", origin: { kind: "self" }, storePath: `${SELF}/lib/c.nix` },
  ],
  importEdges: [
    { from: "self:modules/a.nix", to: "self:lib/c.nix" },
    { from: "self:modules/sub/b.nix", to: "self:lib/c.nix" },
  ],
  configurations: [],
  moduleDirs: ["modules"],
  warnings: [],
};

const config: ConfigData = {
  id: "nixos/test",
  options: [
    opt(["services", "x", "enable"], { customized: true, highestPrio: 100 }),
    opt(["services", "x", "port"]),
    opt(["sops", "secrets"], { customized: true, highestPrio: 100 }),
    opt(["inline", "thing"], { customized: true }),
  ],
  fileIndex: {
    [`${SELF}/modules/a.nix`]: { defines: [0], declares: [] },
    [`${SELF}/modules/sub/b.nix`]: { defines: [], declares: [0, 1] },
    [`${SOPS}/modules/sops/default.nix`]: { defines: [2], declares: [2] },
    ["<unknown-file>"]: { defines: [3], declares: [] },
  },
};

describe("flake indexes", () => {
  const fx = buildFlakeIndexes(manifest);

  test("import graph has forward and reverse edges", () => {
    expect(fx.imports.get("self:modules/a.nix")).toEqual(new Set(["self:lib/c.nix"]));
    expect(fx.importedBy.get("self:lib/c.nix")).toEqual(
      new Set(["self:modules/a.nix", "self:modules/sub/b.nix"]),
    );
  });

  test("resolveFile attributes self, input, patched-input, and unknown", () => {
    expect(resolveFile(`${SELF}/modules/a.nix`, manifest, fx).origin).toEqual({ kind: "self" });
    expect(resolveFile(`${SOPS}/modules/sops/default.nix`, manifest, fx).origin).toEqual({
      kind: "input",
      input: "sops-nix",
    });
    const patched = resolveFile(`${PATCHED}/nixos/modules/x.nix`, manifest, fx);
    expect(patched.origin).toEqual({ kind: "input", input: "nixpkgs", patched: true });
    expect(patched.relPath).toBe("nixos/modules/x.nix");
    const unknown = resolveFile("/nix/store/ee1ee1ee1ee1ee1ee1ee1ee1ee1ee1ee-blob/f.nix", manifest, fx);
    expect(unknown.origin.kind).toBe("unknown");
    expect((unknown.origin as { group?: string }).group).toMatch(/^blob@/);
  });
});

describe("config indexes", () => {
  const fx = buildFlakeIndexes(manifest);
  const ci = buildConfigIndexes(manifest, config, fx);

  test("module tree mounts self files under directory structure", () => {
    const modules = ci.tree.children.find((n) => n.label === "modules")!;
    expect(modules).toBeDefined();
    expect(modules.children.map((c) => c.label)).toEqual(["sub", "a.nix"]);
    expect(modules.customized).toBe(1); // a.nix defines one customized option
  });

  test("input files group under the input root, inline under (inline modules)", () => {
    const sops = ci.tree.children.find((n) => n.id === "input:sops-nix")!;
    expect(sops).toBeDefined();
    expect(sops.customized).toBe(1);
    expect(ci.tree.children.some((n) => n.label === "(inline modules)")).toBe(true);
  });

  test("fileToNodes includes ancestors for hover highlighting", () => {
    const nodes = ci.fileToNodes.get("self:modules/sub/b.nix")!;
    expect(nodes.has("dir:self/modules")).toBe(true);
    expect(nodes.has("dir:self/modules/sub")).toBe(true);
    expect(nodes.has("self:modules/sub/b.nix")).toBe(true);
  });

  test("refsByFile keyed by file id", () => {
    expect(ci.refsByFile.get("self:modules/sub/b.nix")!.declares).toEqual([0, 1]);
    expect(ci.refsByFile.get("inline")!.defines).toEqual([3]);
  });
});
