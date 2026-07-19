// Real-nix integration test against test/fixtures/mini-flake: exercises the
// actual extraction pipeline (buildManifest + extractOptions, both shelling
// out to `nix`) end to end, not synthetic fixture data like the other tests.
// Needs `nix` on PATH — skipped otherwise (checks.test's sandbox has no nix,
// see package.nix's tests.unit derivation). CI's test job installs nix and
// sets FLAKE_EXPLORER_REQUIRE_NIX so a silent skip there is impossible.

import { describe, expect, test } from "bun:test"
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildConfigIndexes, buildFlakeIndexes, resolveFile } from "../app/lib/indexes"
import {
  applyExtracted,
  applyExtractedPackage,
  extractAndPersist,
  extractAndPersistPackage,
  reconcile,
} from "../src/extract/cache"
import { buildManifest } from "../src/extract/manifest"
import { extractOptions } from "../src/extract/options"
import type { Manifest } from "../src/schema"

const FIXTURE = join(import.meta.dir, "fixtures/mini-flake")
const hasNix = !!Bun.which("nix")

if (!hasNix && process.env.FLAKE_EXPLORER_REQUIRE_NIX) {
  throw new Error(
    "FLAKE_EXPLORER_REQUIRE_NIX is set but `nix` is not on PATH — the integration suite would silently skip",
  )
}

describe.skipIf(!hasNix)("mini-flake fixture (real nix)", () => {
  test("manifest: flake, input, files, imports, configurations", async () => {
    const m = await buildManifest(FIXTURE, { timeoutMs: 60_000 })

    expect(m.flake.description).toBe("flake-explorer test fixture")

    // A real input, locked and store-fetched.
    expect(m.inputs.vendor?.type).toBe("path")
    expect(m.inputs.vendor?.storePath).toBeTruthy()

    const relPaths = m.files.map((f) => f.relPath).sort()
    expect(relPaths).toEqual([
      "extras/default.nix",
      "flake.nix",
      "hosts/mini.nix",
      "lib/greeting.nix",
      "lib/helper.nix",
      "modules/networking.nix",
      "modules/nginx.nix",
      "vendor/flake.nix",
      "vendor/modules/extra.nix",
    ])
    // vendor is nested (see flake.nix comment): its files are fetched as part
    // of the outer flake's own store copy, so they surface as "self" too —
    // not a regression, just this Nix's local-path-input behavior.
    expect(m.files.find((f) => f.relPath === "vendor/flake.nix")?.origin.kind).toBe("self")

    const edges = new Set(m.importEdges.map((e) => `${e.from}->${e.to}`))
    expect(edges.has("self:lib/greeting.nix->self:lib/helper.nix")).toBe(true)
    expect(edges.has("self:lib/greeting.nix->self:extras/default.nix")).toBe(true)
    expect(edges.has("self:flake.nix->self:modules/networking.nix")).toBe(true)
    expect(edges.has("self:flake.nix->self:modules/nginx.nix")).toBe(true)
    expect(edges.has("self:flake.nix->self:hosts/mini.nix")).toBe(true)

    expect(m.configurations).toEqual([
      {
        id: "nixos/mini",
        kind: "nixos",
        name: "mini",
        dataFile: "config/nixos.mini.json",
        status: "pending",
      },
    ])

    // packages/devShells/checks/formatter, enumerated straight from the
    // outputs tree (no extra eval) — apps is intentionally out of v1 scope.
    expect(new Set(m.packages.map((p) => p.id))).toEqual(
      new Set([
        "packages/x86_64-linux/mini",
        "devShells/x86_64-linux/default",
        "checks/x86_64-linux/mini-check",
        "formatter/x86_64-linux",
      ]),
    )
    expect(m.packages.find((p) => p.id === "packages/x86_64-linux/mini")).toEqual({
      id: "packages/x86_64-linux/mini",
      path: ["packages", "x86_64-linux", "mini"],
      dataFile: "package/packages.x86_64-linux.mini.json",
      status: "pending",
    })
  })

  test("options: declares vs. defines spans networking.nix, nginx.nix, hosts/mini.nix", async () => {
    const m = await buildManifest(FIXTURE, { timeoutMs: 60_000 })
    const { data } = await extractOptions(FIXTURE, "nixos", "mini", { timeoutMs: 60_000 })

    const byLoc = new Map(data.options.map((o) => [o.loc.join("."), o]))
    expect(byLoc.get("networking.hostName")).toMatchObject({
      customized: true,
      value: "mini",
      default: "unset",
    })
    expect(byLoc.get("services.nginx.enable")).toMatchObject({
      customized: true,
      value: true,
      default: false,
    })
    expect(byLoc.get("services.nginx.package")).toMatchObject({
      customized: false,
      isDefined: false,
      default: "nginx",
    })

    const fx = buildFlakeIndexes(m)
    const indexes = buildConfigIndexes(m, data, fx)

    const hostMeta = resolveFile(`${m.flake.path}/hosts/mini.nix`, m, fx)
    const hostRefs = indexes.refsByFile.get(hostMeta.id)!
    expect(hostRefs.defines.length).toBe(2) // hostName + nginx.enable
    expect(hostRefs.declares.length).toBe(0)

    const nginxMeta = resolveFile(`${m.flake.path}/modules/nginx.nix`, m, fx)
    const nginxRefs = indexes.refsByFile.get(nginxMeta.id)!
    expect(nginxRefs.declares.length).toBe(2) // enable + package
    expect(nginxRefs.defines.length).toBe(0) // "declares" a customized option, doesn't itself define it

    // The module tree groups both declaring files under a "modules" dir node.
    const modulesDir = indexes.tree.children.find((n) => n.label === "modules")
    expect(modulesDir?.children.map((c) => c.label).sort()).toEqual(["networking.nix", "nginx.nix"])
  })

  test("nested repos/worktrees inside the flake dir stay out of the file map", async () => {
    // Under lazy-trees the flake "source" is the working directory, so an
    // untracked git worktree (e.g. .claude/worktrees/*) is visible to the
    // walk. A worktree carries a `.git` FILE, a nested clone a `.git` dir —
    // either marks a different project whose .nix files must not leak in.
    const dir = await mkdtemp(join(tmpdir(), "mini-nested-"))
    try {
      await cp(FIXTURE, dir, { recursive: true })
      await mkdir(join(dir, ".claude/worktrees/scratch"), { recursive: true })
      await Bun.write(join(dir, ".claude/worktrees/scratch/.git"), "gitdir: /elsewhere/.git\n")
      await Bun.write(join(dir, ".claude/worktrees/scratch/junk.nix"), "{ }\n")

      const m = await buildManifest(dir, { timeoutMs: 60_000 })
      const relPaths = m.files.map((f) => f.relPath)
      expect(relPaths).toContain("flake.nix")
      expect(relPaths.filter((p) => p.includes("worktrees"))).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("vendor input is listed and its files resolve (even if not option-attributed)", async () => {
    const m: Manifest = await buildManifest(FIXTURE, { timeoutMs: 60_000 })
    expect(Object.keys(m.inputs)).toEqual(["vendor"])
  })

  test("extractAndPersist writes a blob + sidecar that reconcile then accepts", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "mini-extract-"))
    try {
      const m = await buildManifest(FIXTURE, { timeoutMs: 60_000 })
      const ref = m.configurations[0]!
      const progress: string[] = []

      const r = await extractAndPersist(outDir, FIXTURE, m.flake.narHash, ref, {
        timeoutMs: 60_000,
        onProgress: (p) => progress.push(p.current),
      })
      applyExtracted(ref, r)
      expect(ref.status).toBe("ok")
      expect(ref.optionCount).toBe(r.data.options.length)
      expect(ref.optionCount).toBeGreaterThan(0)
      expect(progress.length).toBeGreaterThan(0)

      const blob = await Bun.file(join(outDir, ref.dataFile)).json()
      expect(blob.id).toBe("nixos/mini")

      // A fresh manifest reconciles against the persisted sidecar → no re-eval.
      const m2 = await buildManifest(FIXTURE, { timeoutMs: 60_000 })
      await reconcile(outDir, m2)
      expect(m2.configurations[0]!.status).toBe("ok")
      expect(m2.configurations[0]!.optionCount).toBe(ref.optionCount)
    } finally {
      await rm(outDir, { recursive: true, force: true })
    }
  })

  test("extractAndPersistPackage writes a blob + sidecar that reconcile then accepts", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "mini-extract-pkg-"))
    try {
      const m = await buildManifest(FIXTURE, { timeoutMs: 60_000 })
      const ref = m.packages.find((p) => p.id === "packages/x86_64-linux/mini")!

      const r = await extractAndPersistPackage(outDir, FIXTURE, m.flake.narHash, ref, {
        timeoutMs: 60_000,
      })
      applyExtractedPackage(ref, r)
      expect(ref.status).toBe("ok")
      expect(Object.hasOwn(ref, "optionCount")).toBe(false)

      // The full real-nix pipeline, end to end: eval markers/meta/deps,
      // `nix derivation show` (drv-level inputs), `nix path-info` (absent —
      // mini is never built).
      expect(r.data.pname).toBe("mini")
      expect(r.data.pkgVersion).toBe("0.1.0")
      expect(r.data.deps.nativeBuildInputs).toEqual(["mini-dep"])
      expect(r.data.meta?.license?.[0]).toMatchObject({ spdxId: "MIT" })
      expect(r.data.drv?.inputDrvs[0]).toMatchObject({ name: "mini-dep" })
      expect(r.data.runtime).toBeUndefined() // never built

      const blob = await Bun.file(join(outDir, ref.dataFile)).json()
      expect(blob.id).toBe("packages/x86_64-linux/mini")

      // A fresh manifest reconciles against the persisted sidecar → no re-eval.
      const m2 = await buildManifest(FIXTURE, { timeoutMs: 60_000 })
      await reconcile(outDir, m2)
      const ref2 = m2.packages.find((p) => p.id === "packages/x86_64-linux/mini")!
      expect(ref2.status).toBe("ok")
    } finally {
      await rm(outDir, { recursive: true, force: true })
    }
  })

  test("devShells/checks/formatter extract too, and classify as builder=unknown (raw derivation, no phases)", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "mini-extract-pkgs-"))
    try {
      const m = await buildManifest(FIXTURE, { timeoutMs: 60_000 })
      for (const id of [
        "devShells/x86_64-linux/default",
        "checks/x86_64-linux/mini-check",
        "formatter/x86_64-linux",
      ]) {
        const ref = m.packages.find((p) => p.id === id)!
        const r = await extractAndPersistPackage(outDir, FIXTURE, m.flake.narHash, ref, {
          timeoutMs: 60_000,
        })
        expect(r.data.builder).toBe("unknown")
        expect(r.data.outputs[0]?.outPath).toContain("/nix/store/")
      }
    } finally {
      await rm(outDir, { recursive: true, force: true })
    }
  })
})
