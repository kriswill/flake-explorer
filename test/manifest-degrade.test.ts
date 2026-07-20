// buildManifest's transitive-input degradation, hermetic via a scripted
// `nix` shim on PATH (the technique from run-nix.test.ts / serve.test.ts).
//
// Resolving an input-of-an-input can abort the eval from below the Nix
// exception layer — a lock entry whose recorded `url` disagrees with what
// the fetcher returns (flakehub pins carrying ?rev=&revCount= do this), which
// not even tryEval catches. The shim reproduces that: the depth-3 manifest
// eval fails, the inputsDepth-0 retry succeeds.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildManifest } from "../src/extract/manifest"

const FLAKE_REF = "github:example/degrade-flake"
/**
 * A REAL temp directory: buildManifest reads self files off disk for the
 * import/input/overlay scans, so covering that wiring hermetically (this
 * suite runs in the sandboxed nix check, where the real-nix mini-flake is
 * skipped) needs somewhere the test can write.
 */
const SELF = join(tmpdir(), "fe-degrade-self-fixture")
const NIXPKGS = "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-source"

/**
 * The `--expr` argv embeds the args JSON with escaped quotes, so the shim
 * matches the literal backslash-quote sequences. A manifest call carrying
 * `inputsDepth: 0` is the retry; anything else is the full-depth attempt,
 * which fails the way the real fetcher does.
 */
const SHIM = `#!/bin/sh
case "$*" in
  *--version*) echo "nix (Nix) 2.34.7" ;;
  *"flake metadata"*) cat "$NIX_SHIM_DIR/metadata.json" ;;
  *"flake show"*) cat "$NIX_SHIM_DIR/show.json" ;;
  *'inputsDepth\\":0'*) cat "$NIX_SHIM_DIR/manifest-shallow.json" ;;
  *'mode\\":\\"manifest'*)
    echo "error: mismatch in field 'url' of input '{\\"type\\":\\"tarball\\"}'" >&2
    exit 1 ;;
  *) echo "nix shim: unexpected argv: $*" >&2; exit 9 ;;
esac
`

const METADATA = {
  description: "degrade test flake",
  path: SELF,
  resolvedUrl: FLAKE_REF,
  url: FLAKE_REF,
  revision: "deadbeef",
  locked: { narHash: "sha256-selfnarhash=", rev: "deadbeef" },
  locks: {
    version: 7,
    root: "root",
    nodes: {
      // The lock graph is unaffected by the fetcher failure, so the
      // transitive entry must still surface — only its store path is lost.
      root: { inputs: { nixpkgs: "nixpkgs" } },
      nixpkgs: {
        inputs: { "nixos-hardware": "nixos-hardware" },
        locked: { type: "github", owner: "NixOS", repo: "nixpkgs", rev: "cafebabe" },
        original: { type: "github", owner: "NixOS", repo: "nixpkgs" },
      },
      "nixos-hardware": {
        locked: { type: "tarball", url: "https://api.flakehub.com/f/pinned/x?rev=1" },
        original: { type: "tarball", url: "https://api.flakehub.com/f/pinned/x" },
      },
    },
  },
}

const SHOW = { nixosConfigurations: { test: { type: "nixos-configuration" } } }

/** What extract.nix returns at inputsDepth 0: direct inputs, no children. */
const MANIFEST_SHALLOW = {
  self: SELF,
  description: "degrade test flake",
  inputs: { nixpkgs: { path: NIXPKGS, inputs: {} } },
  configurations: [{ kind: "nixos", n: "test" }],
  files: [`${SELF}/flake.nix`, `${SELF}/overlays.nix`],
  grafts: [],
  outputNames: {},
}

let dir: string
const origPath = process.env.PATH

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "manifest-degrade-"))
  // Self files the source scans read: an input reference, a relative import,
  // and both overlay definition forms.
  await Bun.write(
    join(SELF, "flake.nix"),
    `{ inputs.nixpkgs.url = "github:NixOS/nixpkgs";\n  outputs = _: { imports = [ ./overlays.nix ]; }; }\n`,
  )
  await Bun.write(
    join(SELF, "overlays.nix"),
    `{ flake.overlays.demo = final: prev: { };\n  overlays.other = final: prev: { }; }\n`,
  )
  await Bun.write(join(dir, "metadata.json"), JSON.stringify(METADATA))
  await Bun.write(join(dir, "show.json"), JSON.stringify(SHOW))
  await Bun.write(join(dir, "manifest-shallow.json"), JSON.stringify(MANIFEST_SHALLOW))
  await Bun.write(join(dir, "nix"), SHIM)
  await chmod(join(dir, "nix"), 0o755)
  process.env.NIX_SHIM_DIR = dir
  process.env.PATH = `${dir}:${origPath}`
})

afterAll(async () => {
  process.env.PATH = origPath
  delete process.env.NIX_SHIM_DIR
  await rm(dir, { recursive: true, force: true })
  await rm(SELF, { recursive: true, force: true })
})

test("an unresolvable transitive input degrades to direct inputs with a warning", async () => {
  const m = await buildManifest(FLAKE_REF, { timeoutMs: 20_000 })

  // The manifest is usable: flake identity, configurations, and outputs all survive.
  expect(m.flake.path).toBe(SELF)
  expect(m.configurations.map((c) => c.id)).toEqual(["nixos/test"])
  expect(m.outputs.kind).toBe("attrset")

  // Every input still appears — the lock graph never depended on the eval.
  expect(Object.keys(m.inputs).sort()).toEqual(["nixpkgs", "nixpkgs/nixos-hardware"])
  expect(m.inputs.nixpkgs?.storePath).toBe(NIXPKGS)
  // ...but the transitive one lost the store path the deep walk would have given it.
  expect(m.inputs["nixpkgs/nixos-hardware"]?.transitive).toBe(true)
  expect(m.inputs["nixpkgs/nixos-hardware"]?.storePath).toBeUndefined()

  // The degradation is stated, naming the underlying nix error.
  const warning = m.warnings.find((w) => w.includes("transitive inputs could not be resolved"))
  expect(warning).toBeDefined()
  expect(warning).toContain("mismatch in field 'url'")
})

test("the self-source scans still run over a degraded manifest", async () => {
  // Degrading the INPUT walk must not quietly drop the file-level scans —
  // they read self files off disk and never touched the failing eval.
  const m = await buildManifest(FLAKE_REF, { timeoutMs: 20_000 })

  expect(m.files.map((f) => f.relPath).sort()).toEqual(["flake.nix", "overlays.nix"])

  // Both overlay definition forms, attributed to the file that defines them.
  expect(m.overlayDefs?.slice().sort((a, b) => a.name.localeCompare(b.name))).toEqual([
    { name: "demo", file: "self:overlays.nix" },
    { name: "other", file: "self:overlays.nix" },
  ])

  expect(m.inputRefs).toEqual([{ file: "self:flake.nix", input: "nixpkgs" }])
  expect(m.importEdges).toEqual([{ from: "self:flake.nix", to: "self:overlays.nix" }])
})
