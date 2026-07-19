import { describe, expect, test } from "bun:test"
import {
  buildConfigIndexes,
  buildFileTree,
  buildFlakeIndexes,
  fileTreeAncestorIds,
  fileTreeMatches,
  groupKeyOf,
  inputLabel,
  inputNameOf,
  parsePosition,
  resolveFile,
  subtreeMatches,
} from "../app/lib/indexes"
import type { ConfigData, Manifest, OptionEntry } from "../src/schema"

const SELF = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-source"
const SOPS = "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-source"
const NIXPKGS = "/nix/store/cccccccccccccccccccccccccccccccc-source"
const PATCHED = `/nix/store/dddddddddddddddddddddddddddddddd-${NIXPKGS.split("/").pop()}`

const opt = (loc: string[], over: Partial<OptionEntry> = {}): OptionEntry => ({
  loc,
  readOnly: false,
  isDefined: true,
  customized: false,
  declarations: [],
  definitions: [],
  ...over,
})

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
    {
      id: "self:modules/a.nix",
      relPath: "modules/a.nix",
      origin: { kind: "self" },
      storePath: `${SELF}/modules/a.nix`,
    },
    {
      id: "self:modules/sub/b.nix",
      relPath: "modules/sub/b.nix",
      origin: { kind: "self" },
      storePath: `${SELF}/modules/sub/b.nix`,
    },
    {
      id: "self:lib/c.nix",
      relPath: "lib/c.nix",
      origin: { kind: "self" },
      storePath: `${SELF}/lib/c.nix`,
    },
  ],
  importEdges: [
    { from: "self:modules/a.nix", to: "self:lib/c.nix" },
    { from: "self:modules/sub/b.nix", to: "self:lib/c.nix" },
  ],
  configurations: [],
  packages: [],
  grafts: [],
  outputNames: {},
  warnings: [],
}

const config: ConfigData = {
  version: 1,
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
    "<unknown-file>": { defines: [3], declares: [] },
  },
}

describe("flake indexes", () => {
  const fx = buildFlakeIndexes(manifest)

  test("import graph has forward and reverse edges", () => {
    expect(fx.imports.get("self:modules/a.nix")).toEqual(new Set(["self:lib/c.nix"]))
    expect(fx.importedBy.get("self:lib/c.nix")).toEqual(
      new Set(["self:modules/a.nix", "self:modules/sub/b.nix"]),
    )
  })

  test("resolveFile attributes self, input, patched-input, and unknown", () => {
    expect(resolveFile(`${SELF}/modules/a.nix`, manifest, fx).origin).toEqual({ kind: "self" })
    expect(resolveFile(`${SOPS}/modules/sops/default.nix`, manifest, fx).origin).toEqual({
      kind: "input",
      input: "sops-nix",
    })
    const patched = resolveFile(`${PATCHED}/nixos/modules/x.nix`, manifest, fx)
    expect(patched.origin).toEqual({ kind: "input", input: "nixpkgs", patched: true })
    expect(patched.relPath).toBe("nixos/modules/x.nix")
    const unknown = resolveFile(
      "/nix/store/ee1ee1ee1ee1ee1ee1ee1ee1ee1ee1ee-blob/f.nix",
      manifest,
      fx,
    )
    expect(unknown.origin.kind).toBe("unknown")
    expect((unknown.origin as { group?: string }).group).toMatch(/^blob@/)
  })
})

describe("config indexes", () => {
  const fx = buildFlakeIndexes(manifest)
  const ci = buildConfigIndexes(manifest, config, fx)

  test("module tree mounts self files under directory structure", () => {
    const modules = ci.tree.children.find((n) => n.label === "modules")!
    expect(modules).toBeDefined()
    expect(modules.children.map((c) => c.label)).toEqual(["sub", "a.nix"])
    expect(modules.customized).toBe(1) // a.nix defines one customized option
  })

  test("input files group under the input root, inline under (inline modules)", () => {
    const sops = ci.tree.children.find((n) => n.id === "input:sops-nix")!
    expect(sops).toBeDefined()
    expect(sops.customized).toBe(1)
    expect(ci.tree.children.some((n) => n.label === "(inline modules)")).toBe(true)
  })

  test("fileToNodes includes ancestors for hover highlighting", () => {
    const nodes = ci.fileToNodes.get("self:modules/sub/b.nix")!
    expect(nodes.has("dir:self/modules")).toBe(true)
    expect(nodes.has("dir:self/modules/sub")).toBe(true)
    expect(nodes.has("self:modules/sub/b.nix")).toBe(true)
  })

  test("refsByFile keyed by file id", () => {
    expect(ci.refsByFile.get("self:modules/sub/b.nix")!.declares).toEqual([0, 1])
    expect(ci.refsByFile.get("inline")!.defines).toEqual([3])
  })

  test("patched and original store paths merge into one file id, refs deduped", () => {
    // Same nixpkgs file seen via the original tree AND a patched copy: both
    // resolve to "input:nixpkgs:<rel>", so their refs concatenate then dedupe.
    const merged: ConfigData = {
      version: 1,
      id: "nixos/test",
      options: [opt(["a"]), opt(["b"]), opt(["c"])],
      fileIndex: {
        [`${NIXPKGS}/nixos/modules/x.nix`]: { defines: [0, 1], declares: [2] },
        [`${PATCHED}/nixos/modules/x.nix`]: { defines: [1, 2, 2], declares: [2] },
      },
    }
    const mi = buildConfigIndexes(manifest, merged, fx)
    expect(mi.refsByFile.size).toBe(1)
    const refs = mi.refsByFile.get("input:nixpkgs:nixos/modules/x.nix")!
    expect(refs.defines).toEqual([0, 1, 2])
    expect(refs.declares).toEqual([2])
    expect(mi.filesById.size).toBe(1)
  })
})

describe("file tree (right pane)", () => {
  const files = [
    { id: "self:zeta.nix", relPath: "zeta.nix", colorKey: "self" },
    { id: "self:modules/sub/b.nix", relPath: "modules/sub/b.nix", colorKey: "self" },
    { id: "self:beta.nix", relPath: "beta.nix", colorKey: "self" },
  ]

  test("buildFileTree sorts files before folders, alphabetical within each", () => {
    const tree = buildFileTree(files, "self")
    // Opposite of the left tree's dirs-first sort: leaves lead at every level.
    expect(tree.children.map((c) => c.label)).toEqual(["beta.nix", "zeta.nix", "modules"])
  })

  test("buildFileTree dir ids are fdir:<groupKey>/<dirpath>, leaves keep fileId", () => {
    const tree = buildFileTree(files, "self")
    expect(tree.id).toBe("fdir:self")
    const modules = tree.children.find((c) => c.label === "modules")!
    expect(modules.id).toBe("fdir:self/modules")
    expect(modules.fileId).toBeUndefined()
    const sub = modules.children[0]!
    expect(sub.id).toBe("fdir:self/modules/sub")
    expect(sub.path).toBe("modules/sub")
    const leaf = sub.children[0]!
    expect(leaf).toMatchObject({
      id: "self:modules/sub/b.nix",
      fileId: "self:modules/sub/b.nix",
      path: "modules/sub/b.nix",
      label: "b.nix",
    })
  })

  test("groupKeyOf maps origins to file-list groups", () => {
    expect(groupKeyOf({ kind: "self" })).toBe("self")
    expect(groupKeyOf({ kind: "input", input: "sops-nix" })).toBe("input:sops-nix")
    expect(groupKeyOf({ kind: "unknown", group: "source@abc1234" })).toBe("input:source@abc1234")
    expect(groupKeyOf({ kind: "unknown" })).toBeNull()
  })

  test("fileTreeAncestorIds lists folder ids down to the file, exclusive", () => {
    expect(fileTreeAncestorIds("input:nixpkgs", "nixos/modules/x.nix")).toEqual([
      "fdir:input:nixpkgs/nixos",
      "fdir:input:nixpkgs/nixos/modules",
    ])
    expect(fileTreeAncestorIds("self", "top.nix")).toEqual([])
  })
})

describe("module tree ordering and rollup", () => {
  // Three input groups where nixpkgs is NOT alphabetically last: inputs must
  // still land after the flake's own entries, alphabetical, nixpkgs pinned last.
  const ALPHA = "/nix/store/ffffffffffffffffffffffffffffffff-source"
  const m: Manifest = {
    ...manifest,
    inputs: {
      ...manifest.inputs,
      alpha: { name: "alpha", nodeKey: "alpha", type: "github", storePath: ALPHA },
    },
  }

  test("input groups render after self entries, alphabetical with nixpkgs last", () => {
    const cfg: ConfigData = {
      version: 1,
      id: "nixos/test",
      options: [opt(["a"]), opt(["b"]), opt(["c"]), opt(["d"])],
      fileIndex: {
        [`${SELF}/modules/a.nix`]: { defines: [0], declares: [] },
        [`${ALPHA}/mod.nix`]: { defines: [1], declares: [] },
        [`${SOPS}/mod.nix`]: { defines: [2], declares: [] },
        [`${NIXPKGS}/nixos/modules/x.nix`]: { defines: [3], declares: [] },
      },
    }
    const ci = buildConfigIndexes(m, cfg, buildFlakeIndexes(m))
    expect(ci.tree.children.map((c) => c.id)).toEqual([
      "dir:self/modules", // self entries first, even though "alpha" < "modules"
      "input:alpha",
      "input:sops-nix",
      "input:nixpkgs", // pinned last despite nixpkgs < sops-nix alphabetically
    ])
  })

  test("customized/declares roll up through every intermediate directory level", () => {
    const deep: Manifest = {
      ...manifest,
      files: [
        {
          id: "self:modules/a/b/c.nix",
          relPath: "modules/a/b/c.nix",
          origin: { kind: "self" },
          storePath: `${SELF}/modules/a/b/c.nix`,
        },
        {
          id: "self:modules/a/d.nix",
          relPath: "modules/a/d.nix",
          origin: { kind: "self" },
          storePath: `${SELF}/modules/a/d.nix`,
        },
        {
          id: "self:modules/e.nix",
          relPath: "modules/e.nix",
          origin: { kind: "self" },
          storePath: `${SELF}/modules/e.nix`,
        },
      ],
      importEdges: [],
    }
    const cfg: ConfigData = {
      version: 1,
      id: "nixos/test",
      options: [opt(["a"]), opt(["b"]), opt(["c"])],
      fileIndex: {
        [`${SELF}/modules/a/b/c.nix`]: { defines: [0], declares: [] },
        [`${SELF}/modules/a/d.nix`]: { defines: [1], declares: [2] },
        [`${SELF}/modules/e.nix`]: { defines: [], declares: [0, 1] },
      },
    }
    const ci = buildConfigIndexes(deep, cfg, buildFlakeIndexes(deep))
    const modules = ci.tree.children.find((n) => n.id === "dir:self/modules")!
    const a = modules.children.find((n) => n.id === "dir:self/modules/a")!
    const b = a.children.find((n) => n.id === "dir:self/modules/a/b")!
    // Each level sums exactly its subtree — grandparents included.
    expect(b).toMatchObject({ customized: 1, declares: 0 })
    expect(a).toMatchObject({ customized: 2, declares: 1 })
    expect(modules).toMatchObject({ customized: 2, declares: 3 })
    expect(ci.tree).toMatchObject({ customized: 2, declares: 3 })
  })
})

describe("inputNameOf", () => {
  test("resolves group-root and file-leaf input ids, null otherwise", () => {
    expect(inputNameOf("input:sops-nix")).toBe("sops-nix")
    expect(inputNameOf("input:sops-nix:modules/x.nix")).toBe("sops-nix")
    expect(inputNameOf("self:a.nix")).toBeNull()
    expect(inputNameOf("dir:self/modules")).toBeNull()
  })
})

describe("inputLabel", () => {
  test("plain input is just its name; aliases render as 'alias → name'", () => {
    expect(inputLabel({ name: "nixpkgs", nodeKey: "np", type: "github" })).toBe("nixpkgs")
    expect(inputLabel({ name: "nixpkgs", nodeKey: "np", type: "github", aliases: [] })).toBe(
      "nixpkgs",
    )
    expect(
      inputLabel({ name: "nixpkgs", nodeKey: "np", type: "github", aliases: ["stable"] }),
    ).toBe("stable → nixpkgs")
    expect(
      inputLabel({ name: "nixpkgs", nodeKey: "np", type: "github", aliases: ["a", "b"] }),
    ).toBe("a, b → nixpkgs")
  })
})

describe("parsePosition", () => {
  test("splits a trailing :line, keeps colons inside the path", () => {
    expect(parsePosition("/nix/store/x-source/pkgs/default.nix:42")).toEqual({
      file: "/nix/store/x-source/pkgs/default.nix",
      line: "42",
    })
    expect(parsePosition("a:b/c.nix:7")).toEqual({ file: "a:b/c.nix", line: "7" })
  })

  test("no numeric suffix: whole string is the file, line absent", () => {
    expect(parsePosition("pkgs/default.nix")).toEqual({ file: "pkgs/default.nix" })
    expect(parsePosition("file.nix:abc")).toEqual({ file: "file.nix:abc" })
  })
})

describe("tree search (subtreeMatches / fileTreeMatches)", () => {
  const files = [
    { id: "self:modules/Git.nix", relPath: "modules/Git.nix", colorKey: "self" },
    { id: "self:top.nix", relPath: "top.nix", colorKey: "self" },
  ]
  const tree = buildFileTree(files, "self")

  test("files match on full relPath, case-insensitive; folders only via contents", () => {
    expect(fileTreeMatches(tree, "git")).toBe(true) // via modules/Git.nix
    expect(fileTreeMatches(tree, "modules/git")).toBe(true) // path, not just label
    // A folder's own name alone never matches — no file under it matches "modules".
    const modules = tree.children.find((c) => c.label === "modules")!
    expect(fileTreeMatches(modules, "zzz")).toBe(false)
    expect(fileTreeMatches(tree, "")).toBe(true)
  })

  test("generic subtreeMatches keeps a node when any descendant's text matches", () => {
    type N = { label: string; kids: N[] }
    const n: N = { label: "root", kids: [{ label: "Leaf", kids: [] }] }
    const match = (node: N, q: string) =>
      subtreeMatches(
        node,
        q,
        (x) => x.label,
        (x) => x.kids,
      )
    expect(match(n, "leaf")).toBe(true)
    expect(match(n, "root")).toBe(true)
    expect(match(n, "nope")).toBe(false)
  })
})
