import { expect, test } from "bun:test"
import { buildPackageReverseDeps } from "../src/extract/reverse-deps"
import type { PackageData } from "../src/schema"

/** Minimal PackageData: just the id + a drv with a drvPath and inputDrvs. */
const pkg = (id: string, drvPath: string | null, inputDrvPaths: string[] = []): PackageData =>
  ({
    version: 1,
    id,
    path: id.split("/"),
    builder: "unknown",
    outputs: [],
    deps: { nativeBuildInputs: [], buildInputs: [], propagatedBuildInputs: [] },
    warnings: [],
    drv: drvPath
      ? {
          drvPath,
          system: "x86_64-linux",
          builderPath: "/bin/sh",
          inputDrvs: inputDrvPaths.map((p) => ({ drvPath: p, name: "x", outputs: ["out"] })),
          phases: [],
        }
      : undefined,
  }) as PackageData

const mapOf = (...pkgs: PackageData[]) => new Map(pkgs.map((p) => [p.id, p]))

test("joins on drvPath: a depends on b → reverse[b] = [a]", () => {
  const rev = buildPackageReverseDeps(
    mapOf(pkg("b", "/nix/store/b.drv"), pkg("a", "/nix/store/a.drv", ["/nix/store/b.drv"])),
  )
  expect(rev).toEqual({ b: ["a"] })
})

test("aliased derivations (shared drvPath) BOTH get credited", () => {
  // packages.default = packages.myapp → same drvPath under two refIds; a
  // dependent must show up on BOTH pages, not just the last-registered one.
  const rev = buildPackageReverseDeps(
    mapOf(
      pkg("myapp", "/nix/store/app.drv"),
      pkg("default", "/nix/store/app.drv"),
      pkg("tool", "/nix/store/tool.drv", ["/nix/store/app.drv"]),
    ),
  )
  expect(rev.myapp).toEqual(["tool"])
  expect(rev.default).toEqual(["tool"])
})

test("skips self-edges and packages with no drv; nixpkgs (unknown) drvPaths drop out", () => {
  const rev = buildPackageReverseDeps(
    mapOf(
      // self-referential inputDrv must not list itself
      pkg("selfish", "/nix/store/s.drv", ["/nix/store/s.drv"]),
      // depends only on an un-extracted nixpkgs drv → no edge
      pkg("leaf", "/nix/store/leaf.drv", ["/nix/store/nixpkgs-hello.drv"]),
      // no drv at all → contributes nothing, crashes nothing
      pkg("nodrv", null, []),
    ),
  )
  expect(rev).toEqual({})
})

test("a dependent listing the same drv twice appears once", () => {
  const rev = buildPackageReverseDeps(
    mapOf(
      pkg("lib", "/nix/store/lib.drv"),
      pkg("app", "/nix/store/app.drv", ["/nix/store/lib.drv", "/nix/store/lib.drv"]),
    ),
  )
  expect(rev).toEqual({ lib: ["app"] })
})
