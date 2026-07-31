// Shared hand-written fixtures for unit and component tests.

import type {
  ConfigData,
  GraphData,
  GraphRef,
  Manifest,
  OptionEntry,
  PackageRef,
} from "../lib/schema"

export const SELF = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-source"
export const SOPS = "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-source"
export const NIXPKGS = "/nix/store/cccccccccccccccccccccccccccccccc-source"
export const PATCHED = `/nix/store/dddddddddddddddddddddddddddddddd-${NIXPKGS.split("/").pop()}`

export const opt = (loc: string[], over: Partial<OptionEntry> = {}): OptionEntry => ({
  loc,
  readOnly: false,
  isDefined: true,
  customized: false,
  declarations: [],
  definitions: [],
  ...over,
})

export const fixtureManifest = (): Manifest => ({
  version: 1,
  generatedAt: "2026-07-06T00:00:00Z",
  extractor: "test",
  flake: { ref: "/etc/test", path: SELF, description: "test flake" },
  outputs: {
    kind: "attrset",
    children: {
      nixosConfigurations: {
        kind: "attrset",
        children: { test: { kind: "leaf", type: "NixOS configuration" } },
      },
      packages: {
        kind: "attrset",
        children: {
          "x86_64-linux": {
            kind: "attrset",
            children: { hello: { kind: "leaf", type: "package", name: "hello-1.0" } },
          },
          "aarch64-darwin": { kind: "omitted" },
        },
      },
      devShells: {
        kind: "attrset",
        children: {
          "x86_64-linux": {
            kind: "attrset",
            children: { default: { kind: "leaf", type: "development environment" } },
          },
        },
      },
      checks: {
        kind: "attrset",
        children: {
          "x86_64-linux": {
            kind: "attrset",
            children: { test: { kind: "leaf", type: "derivation" } },
          },
        },
      },
      formatter: {
        kind: "attrset",
        children: { "x86_64-linux": { kind: "leaf", type: "package", name: "nixfmt" } },
      },
      // apps are intentionally NOT enumerated by packageRefs (v1 scope).
      apps: {
        kind: "attrset",
        children: {
          "x86_64-linux": {
            kind: "attrset",
            children: { hello: { kind: "leaf", type: "app" } },
          },
        },
      },
      weird: { kind: "unknown" },
    },
  },
  inputs: {
    "sops-nix": {
      name: "sops-nix",
      nodeKey: "sops-nix",
      type: "github",
      url: "https://github.com/Mic92/sops-nix",
      rev: "abcdef1234567890",
      narHash: "sha256-AAAA",
      storePath: SOPS,
    },
    nixpkgs: { name: "nixpkgs", nodeKey: "nixpkgs", type: "github", storePath: NIXPKGS },
  },
  files: [
    {
      id: "self:modules/a.nix",
      relPath: "modules/a.nix",
      origin: { kind: "self" },
      storePath: `${SELF}/modules/a.nix`,
      git: {
        commit: "1234567890abcdef",
        date: "2026-07-01T10:00:00-07:00",
        subject: "add module a",
      },
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
  inputRefs: [{ file: "self:modules/a.nix", input: "sops-nix" }],
  inputFollows: [{ name: "sops-nix/nixpkgs", target: "nixpkgs" }],
  configurations: [
    {
      id: "nixos/test",
      kind: "nixos",
      name: "test",
      dataFile: "config/nixos.test.json",
      status: "ok",
    },
  ],
  packages: fixturePackageRefs(),
  grafts: [],
  outputNames: {},
  warnings: [],
})

/** Matches fixtureManifest().outputs' packages/devShells/checks/formatter (not apps). */
export function fixturePackageRefs(): PackageRef[] {
  const ref = (path: string[]): PackageRef => ({
    id: path.join("/"),
    path,
    dataFile: `package/${path.join(".")}.json`,
    status: "pending",
  })
  return [
    ref(["packages", "x86_64-linux", "hello"]),
    ref(["devShells", "x86_64-linux", "default"]),
    ref(["checks", "x86_64-linux", "test"]),
    ref(["formatter", "x86_64-linux"]),
  ]
}

/**
 * Graph refs for the same outputs — the ids deliberately coincide with
 * fixturePackageRefs()' (real manifests have identical id sets), while the
 * dataFile does not.
 *
 * Deliberately NOT wired into fixtureManifest(): `manifest.graphs` is
 * `#[serde(default)]` on the extractor side, so a manifest with no `graphs`
 * key at all is a real shape, and leaving the default fixture that way makes
 * every other test a standing check that nothing throws on it. Tests that
 * need graphs assign this explicitly.
 */
export function fixtureGraphRefs(): GraphRef[] {
  const ref = (path: string[]): GraphRef => ({
    id: path.join("/"),
    path,
    dataFile: `graph/${path.join(".")}.json`,
    status: "pending",
  })
  return [ref(["packages", "x86_64-linux", "hello"]), ref(["devShells", "x86_64-linux", "default"])]
}

/**
 * A small but structurally real GraphData: root is NOT index 0, one output is
 * pathless, and the presence tier is on so `present` means something.
 *
 *   hello(2) -> stdenv(1) -> bash(0)
 *   hello(2) -> fetch(3)   (a fixed-output fetcher: pathless output)
 */
export const fixtureGraph = (id = "packages/x86_64-linux/hello"): GraphData => ({
  version: 1,
  id,
  root: 2,
  extractedAt: "2026-07-29T06:52:37.030Z",
  nodes: [
    {
      drvPath: "/nix/store/g0000000000000000000000000000000-bash.drv",
      name: "bash",
      system: "x86_64-linux",
      outputs: [
        {
          name: "out",
          path: "/nix/store/g1111111111111111111111111111111-bash",
          present: true,
          narSize: 1024,
          closureSize: 4096,
        },
      ],
    },
    {
      drvPath: "/nix/store/g2222222222222222222222222222222-stdenv.drv",
      name: "stdenv",
      system: "x86_64-linux",
      outputs: [
        {
          name: "out",
          path: "/nix/store/g3333333333333333333333333333333-stdenv",
          present: false,
        },
      ],
    },
    {
      drvPath: "/nix/store/g4444444444444444444444444444444-hello-1.0.drv",
      name: "hello-1.0",
      system: "x86_64-linux",
      outputs: [
        {
          name: "out",
          path: "/nix/store/g5555555555555555555555555555555-hello-1.0",
          present: false,
        },
      ],
    },
    {
      drvPath: "/nix/store/g6666666666666666666666666666666-source.drv",
      name: "source",
      system: "builtin",
      outputs: [{ name: "out" }],
    },
  ],
  edges: [[], [0], [1, 3], []],
  tiers: { presence: true, sizes: true, dryRun: false, substituters: false },
  stats: {
    nodeCount: 4,
    edgeCount: 4,
    outputPathCount: 3,
    uniqueOutputPathCount: 3,
    absentCount: 2,
  },
  warnings: [],
})

export const fixtureConfig = (): ConfigData => ({
  version: 1,
  id: "nixos/test",
  options: [
    opt(["services", "x", "enable"], {
      customized: true,
      highestPrio: 100,
      type: "boolean",
      value: true,
      default: false,
      declarations: [{ file: `${SELF}/modules/sub/b.nix` }],
      definitions: [{ file: `${SELF}/modules/a.nix`, value: true }],
    }),
    opt(["services", "x", "port"], {
      type: "signed integer",
      value: 8080,
      default: 8080,
      highestPrio: 1500,
      declarations: [{ file: `${SELF}/modules/sub/b.nix` }],
      definitions: [{ file: `${SELF}/modules/sub/b.nix`, value: 8080 }],
    }),
    opt(["sops", "secrets"], {
      customized: true,
      highestPrio: 50,
      declarations: [{ file: `${SOPS}/modules/sops/default.nix` }],
      definitions: [{ file: `${SELF}/modules/a.nix`, value: {} }],
    }),
  ],
  fileIndex: {
    [`${SELF}/modules/a.nix`]: { defines: [0, 2], declares: [] },
    [`${SELF}/modules/sub/b.nix`]: { defines: [], declares: [0, 1] },
    [`${SOPS}/modules/sops/default.nix`]: { defines: [], declares: [2] },
  },
})
