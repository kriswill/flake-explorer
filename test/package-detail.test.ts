// PackageDetail.svelte: loading/error/retry/loaded sections. Stage.svelte's
// dispatch to it (and the generic leaf fallback for non-package outputs) is
// covered in stage.test.ts alongside Stage's other selection-kind branches.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { flushSync, mount, unmount } from "svelte"
import PackageDetail from "../app/components/PackageDetail.svelte"
import { buildFlakeIndexes } from "../app/lib/indexes"
import { app } from "../app/lib/state.svelte"
import type { PackageData } from "../src/schema"
import { fixtureManifest, fixturePackageRefs, SELF } from "./fixtures/data"
import { buttonsWithText, withMount } from "./helpers"

const PKG_ID = "packages/x86_64-linux/hello"

function seed() {
  const manifest = fixtureManifest()
  app.manifest = manifest
  app.flakeIndexes = buildFlakeIndexes(manifest)
  app.packages = {}
  app.configs = {}
  app.selection = null
}

beforeEach(seed)

const injected: HTMLElement[] = []
afterEach(() => {
  for (const el of injected.splice(0)) el.remove()
})

function injectPackageData(dataFile: string, data: unknown) {
  const el = document.createElement("script")
  el.type = "application/json"
  el.id = `data:${dataFile}`
  el.textContent = JSON.stringify(data)
  document.head.appendChild(el)
  injected.push(el)
}

const samplePackage = (): PackageData => ({
  version: 1,
  id: PKG_ID,
  path: ["packages", "x86_64-linux", "hello"],
  name: "hello-2.12.3",
  pname: "hello",
  pkgVersion: "2.12.3",
  builder: "stdenv",
  stdenv: "stdenv-linux",
  system: "x86_64-linux",
  meta: {
    description: "A program that produces a familiar, friendly greeting",
    homepage: "https://www.gnu.org/software/hello/",
    license: [{ shortName: "gpl3Plus", spdxId: "GPL-3.0-or-later" }],
    platforms: ["x86_64-linux", "aarch64-darwin"],
    mainProgram: "hello",
    maintainers: [{ name: "Eelco Dolstra", github: "edolstra" }],
  },
  src: { url: "mirror://gnu/hello/hello-2.12.3.tar.gz", outputHash: "sha256-abc" },
  outputs: [{ name: "out", outPath: "/nix/store/xxx-hello-2.12.3" }],
  deps: { nativeBuildInputs: [], buildInputs: [], propagatedBuildInputs: [] },
  drv: {
    drvPath: "/nix/store/yyy-hello-2.12.3.drv",
    system: "x86_64-linux",
    builderPath: "/nix/store/bash/bin/bash",
    inputDrvs: [{ drvPath: "/nix/store/zzz-gcc.drv", name: "gcc", outputs: ["out"] }],
    phases: [{ name: "buildPhase", script: "make", tokens: [] }],
    doCheck: true,
  },
  runtime: {
    out: {
      outPath: "/nix/store/xxx-hello-2.12.3",
      references: ["/nix/store/xxx-hello-2.12.3", "/nix/store/yyy-glibc"],
      narSize: 123_456,
      closureSize: 5_000_000,
    },
  },
  warnings: [],
})

describe("PackageDetail", () => {
  test("non-package categories carry a role badge; packages carry none", () => {
    // checks/devShells/formatter all render through PackageDetail (they are
    // PackageRefs), so without a label the page reads as a plain package.
    const cases: [string, string[], string | null][] = [
      ["checks/x86_64-linux/test", ["checks", "x86_64-linux", "test"], "check"],
      ["devShells/x86_64-linux/default", ["devShells", "x86_64-linux", "default"], "dev shell"],
      ["formatter/x86_64-linux", ["formatter", "x86_64-linux"], "formatter"],
      ["packages/x86_64-linux/hello", ["packages", "x86_64-linux", "hello"], null],
    ]
    for (const [id, path, role] of cases) {
      app.packages = { [id]: { data: { ...samplePackage(), id, path } } }
      withMount(PackageDetail, { refId: id }, (host) => {
        const badges = [...host.querySelectorAll(".badge")].map((b) => b.textContent)
        if (role) expect(badges).toContain(role)
        // The builder badge is always present and never doubles as the role.
        expect(badges).toContain("stdenv")
        // A plain package gets no role label at all — the category IS package.
        const roles = ["check", "dev shell", "formatter"]
        expect(badges.filter((b) => roles.includes(b ?? ""))).toEqual(role ? [role] : [])
      })
    }
  })

  test("unknown ref renders a placeholder", () => {
    withMount(PackageDetail, { refId: "packages/x86_64-linux/nope" }, (host) => {
      expect(host.textContent).toContain("Unknown package")
    })
  })

  test("loading state", () => {
    app.packages = { [PKG_ID]: "loading" }
    withMount(PackageDetail, { refId: PKG_ID }, (host) => {
      expect(host.textContent).toContain("Evaluating package")
    })
  })

  test("error state shows first line only, with a retry button", () => {
    app.packages = { [PKG_ID]: { error: "boom: eval failed\nsecond line" } }
    withMount(PackageDetail, { refId: PKG_ID }, (host) => {
      expect(host.textContent).toContain("boom: eval failed")
      expect(host.textContent).not.toContain("second line")
      expect(buttonsWithText(host, "retry").length).toBe(1)
    })
  })

  test("a permanent error hides the retry button", () => {
    app.packages = { [PKG_ID]: { error: "not included in this export", permanent: true } }
    withMount(PackageDetail, { refId: PKG_ID }, (host) => {
      expect(buttonsWithText(host, "retry").length).toBe(0)
    })
  })

  test("retry evicts the error slot and reloads from the injected data tag", async () => {
    injectPackageData(fixturePackageRefs()[0]!.dataFile, samplePackage())
    app.packages = { [PKG_ID]: { error: "boom" } }
    const host = document.createElement("div")
    document.body.appendChild(host)
    const instance = mount(PackageDetail, { target: host, props: { refId: PKG_ID } })
    try {
      flushSync()
      buttonsWithText(host, "retry")[0]!.click()
      await Bun.sleep(0)
      flushSync()
      expect(host.querySelector("h2")?.textContent).toBe("hello")
    } finally {
      void unmount(instance)
      host.remove()
    }
  })

  test("loaded package renders summary, metadata, source, build, deps, outputs, and runtime", () => {
    app.packages = { [PKG_ID]: { data: samplePackage() } }
    withMount(PackageDetail, { refId: PKG_ID }, (host) => {
      expect(host.querySelector("h2")?.textContent).toBe("hello")
      expect(host.querySelector(".badge.builder")?.textContent).toBe("stdenv")
      expect(host.querySelector(".path")?.textContent).toBe("packages.x86_64-linux.hello")

      const dtdd = (label: string) => {
        const dt = [...host.querySelectorAll("dt")].find((d) => d.textContent === label)
        return dt?.nextElementSibling?.textContent?.trim()
      }
      expect(dtdd("pname")).toBe("hello")
      expect(dtdd("version")).toBe("2.12.3")
      expect(dtdd("stdenv")).toBe("stdenv-linux")
      expect(dtdd("mainProgram")).toBe("hello")

      const licenseLink = host.querySelector<HTMLAnchorElement>("a.urltag")
      expect(licenseLink?.href).toBe("https://spdx.org/licenses/GPL-3.0-or-later.html")
      expect(licenseLink?.textContent).toBe("GPL-3.0-or-later")

      expect(dtdd("outputHash")).toBe("sha256-abc")
      expect(dtdd("builder")).toBe("/nix/store/bash/bin/bash")
      expect(dtdd("doCheck")).toBe("true")

      expect(host.textContent).toContain("No declared build inputs.")
      expect(buttonsWithText(host, "").length).toBeGreaterThanOrEqual(0) // no crash on empty-label buttons
      const drvSummary = [...host.querySelectorAll("summary")].find((s) =>
        s.textContent?.includes("drv-level inputs"),
      )
      expect(drvSummary?.textContent).toContain("1 drv-level inputs")
      expect(host.textContent).toContain("gcc")

      const phaseSummary = [...host.querySelectorAll("summary")].find(
        (s) => s.textContent === "buildPhase",
      )
      expect(phaseSummary).not.toBeUndefined()

      expect(host.textContent).toContain("in store")
      expect(host.textContent).toMatch(/narSize .*KB/)
      expect(host.textContent).toMatch(/closureSize .*MB/)
    })
  })

  test("position under the flake's own path renders a clickable header chip", () => {
    const data = {
      ...samplePackage(),
      meta: { ...samplePackage().meta, position: `${SELF}/pkgs/hello/default.nix:42` },
    }
    app.packages = { [PKG_ID]: { data } }
    withMount(PackageDetail, { refId: PKG_ID }, (host) => {
      expect(host.textContent).toContain("default.nix:42")
      const chip = buttonsWithText(host, "file")[0]
      expect(chip).not.toBeUndefined()
      chip!.click()
      flushSync()
      expect(app.selection?.kind).toBe("file")
    })
  })

  test("position outside the flake's own path renders as plain text, no chip", () => {
    const data = {
      ...samplePackage(),
      meta: { ...samplePackage().meta, position: "/nix/store/other-source/default.nix:1" },
    }
    app.packages = { [PKG_ID]: { data } }
    withMount(PackageDetail, { refId: PKG_ID }, (host) => {
      expect(buttonsWithText(host, "file").length).toBe(0)
      expect(host.textContent).toContain("/nix/store/other-source/default.nix:1")
    })
  })

  test("a minimal package (no meta/src/drv/runtime) renders without those sections", () => {
    const data: PackageData = {
      version: 1,
      id: PKG_ID,
      path: ["packages", "x86_64-linux", "hello"],
      builder: "unknown",
      outputs: [{ name: "out" }],
      deps: { nativeBuildInputs: [], buildInputs: [], propagatedBuildInputs: [] },
      warnings: [],
    }
    app.packages = { [PKG_ID]: { data } }
    withMount(PackageDetail, { refId: PKG_ID }, (host) => {
      expect(host.querySelector("h2")?.textContent).toBe("hello") // falls back to the last path segment
      expect(host.textContent).not.toContain("Metadata")
      expect(host.textContent).not.toContain("Source")
      expect(host.textContent).not.toContain("Build")
      expect(host.textContent).toContain("No declared build inputs.")
      expect(host.textContent).not.toContain("Runtime closure")
      // The lone output has no outPath — no "in store" badge, no dash detail.
      expect(host.querySelector(".outs li")?.textContent?.trim()).toBe("out")
    })
  })

  test("broken and unfree flags render as their own rows", () => {
    const data = {
      ...samplePackage(),
      meta: { ...samplePackage().meta, broken: true, unfree: true },
    }
    app.packages = { [PKG_ID]: { data } }
    withMount(PackageDetail, { refId: PKG_ID }, (host) => {
      const dtdd = (label: string) => {
        const dt = [...host.querySelectorAll("dt")].find((d) => d.textContent === label)
        return dt?.nextElementSibling
      }
      expect(dtdd("broken")?.textContent).toBe("true")
      expect(dtdd("broken")?.classList.contains("err")).toBe(true)
      expect(dtdd("unfree")?.textContent).toBe("true")
    })
  })

  test("static reverse-dep index: dependents list 'in this flake' when export is complete", () => {
    const manifest = fixtureManifest()
    manifest.packages = fixturePackageRefs().map((r) => ({ ...r, status: "ok" as const }))
    // "ghost" has no manifest ref — renders as its bare id, no link.
    manifest.packageReverseDeps = { [PKG_ID]: ["checks/x86_64-linux/test", "ghost/pkg"] }
    app.manifest = manifest
    app.flakeIndexes = buildFlakeIndexes(manifest)
    app.packages = { [PKG_ID]: { data: samplePackage() } }
    withMount(PackageDetail, { refId: PKG_ID }, (host) => {
      const section = [...host.querySelectorAll("section")].find((s) =>
        s.textContent?.includes("Depended on by"),
      )!
      expect(section.querySelector(".count")?.textContent).toBe("2")
      expect(section.querySelector(".scope")?.textContent).toBe("in this flake")
      expect(section.textContent).toContain("ghost/pkg")
      // No serve-mode affordance when the index is authoritative.
      expect(buttonsWithText(section as HTMLElement, "load").length).toBe(0)
      const link = [...section.querySelectorAll("button")].find((b) => b.textContent === "test")!
      link.click()
      flushSync()
      expect(app.selection).toEqual({ kind: "output", path: ["checks", "x86_64-linux", "test"] })
    })
  })

  test("complete static export without dependents: flake-wide empty note", () => {
    app.manifest!.packages = fixturePackageRefs().map((r) => ({ ...r, status: "ok" as const }))
    app.manifest!.packageReverseDeps = {}
    app.packages = { [PKG_ID]: { data: samplePackage() } }
    withMount(PackageDetail, { refId: PKG_ID }, (host) => {
      expect(host.textContent).toContain("No other package in this flake depends on it.")
    })
  })

  test("static index over a partial export: 'among exported packages', honest empty note", () => {
    // fixture refs default to status "pending" — a partial --packages export.
    app.manifest!.packageReverseDeps = {}
    app.packages = { [PKG_ID]: { data: samplePackage() } }
    withMount(PackageDetail, { refId: PKG_ID }, (host) => {
      const section = [...host.querySelectorAll("section")].find((s) =>
        s.textContent?.includes("Depended on by"),
      )!
      expect(section.querySelector(".scope")?.textContent).toBe("among exported packages")
      expect(section.textContent).toContain("No exported package depends on it.")
    })
  })

  test("serve mode derives dependents from packages loaded this session", () => {
    // No packageReverseDeps on the manifest — the serve-mode shape.
    const dependent: PackageData = {
      ...samplePackage(),
      id: "checks/x86_64-linux/test",
      path: ["checks", "x86_64-linux", "test"],
      drv: {
        ...samplePackage().drv!,
        drvPath: "/nix/store/ttt-test.drv",
        inputDrvs: [{ drvPath: samplePackage().drv!.drvPath, name: "hello", outputs: ["out"] }],
      },
    }
    app.packages = {
      [PKG_ID]: { data: samplePackage() },
      "checks/x86_64-linux/test": { data: dependent },
      "devShells/x86_64-linux/default": { error: "boom" }, // errored slot: never a dependent
    }
    withMount(PackageDetail, { refId: PKG_ID }, (host) => {
      const section = [...host.querySelectorAll("section")].find((s) =>
        s.textContent?.includes("Depended on by"),
      )!
      expect(section.querySelector(".count")?.textContent).toBe("1")
      expect(section.querySelector(".scope")?.textContent).toBe("among loaded packages")
      expect([...section.querySelectorAll(".revdeps button")].map((b) => b.textContent)).toEqual([
        "test",
      ])
      // One package (formatter) is neither loaded nor errored — offer the rest.
      const loadAll = buttonsWithText(section as HTMLElement, "load 1 more package ")
      expect(loadAll.length).toBe(1)
    })
  })

  test("serve mode without dependents: honest empty note, load-all loads every package", () => {
    app.packages = { [PKG_ID]: { data: samplePackage() } }
    withMount(PackageDetail, { refId: PKG_ID }, (host) => {
      expect(host.textContent).toContain("No dependents among loaded packages.")
      const loadAll = buttonsWithText(host, "load 3 more packages")[0]!
      loadAll.click()
      flushSync()
      // Every ref now occupies a slot (here: permanent "not in export" errors),
      // so the affordance disappears rather than promising more.
      expect(Object.keys(app.packages).length).toBe(4)
      expect(buttonsWithText(host, "more package").length).toBe(0)
    })
  })

  test("warnings render in a collapsed details block", () => {
    const data = {
      ...samplePackage(),
      warnings: ["meta unavailable for hello (broken/unfree package?)"],
    }
    app.packages = { [PKG_ID]: { data } }
    withMount(PackageDetail, { refId: PKG_ID }, (host) => {
      const summary = [...host.querySelectorAll("details summary")].find((s) =>
        s.textContent?.includes("extraction warnings"),
      )
      expect(summary?.textContent).toContain("1 extraction warnings")
      expect(host.textContent).toContain("meta unavailable for hello")
    })
  })
})
