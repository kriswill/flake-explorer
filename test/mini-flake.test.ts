// Real-nix integration test against test/fixtures/mini-flake: exercises the
// actual extraction pipeline (buildManifest + extractOptions, both shelling
// out to `nix`) end to end, not synthetic fixture data like the other tests.
// Needs `nix` on PATH — skipped otherwise (checks.test's sandbox has no nix,
// see package.nix's tests.unit derivation).

import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { buildConfigIndexes, buildFlakeIndexes, resolveFile } from "../app/lib/indexes"
import { buildManifest } from "../src/extract/manifest"
import { extractOptions } from "../src/extract/options"
import type { Manifest } from "../src/schema"

const FIXTURE = join(import.meta.dir, "fixtures/mini-flake")
const hasNix = !!Bun.which("nix")

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

  test("vendor input is listed and its files resolve (even if not option-attributed)", async () => {
    const m: Manifest = await buildManifest(FIXTURE, { timeoutMs: 60_000 })
    expect(Object.keys(m.inputs)).toEqual(["vendor"])
  })
})
