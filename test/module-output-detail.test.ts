// ModuleOutputDetail: flake.modules.* / nixosModules output pages routed to
// their consuming module files via the module system's via-provenance stamps
// (DeclarationRef.via / DefinitionRef.via).

import { beforeEach, describe, expect, test } from "bun:test"
import ModuleOutputDetail from "../app/components/ModuleOutputDetail.svelte"
import { buildConfigIndexes, buildFlakeIndexes } from "../app/lib/indexes"
import { app } from "../app/lib/state.svelte"
import { fixtureConfig, fixtureManifest, opt, SELF } from "./fixtures/data"
import { withMount } from "./helpers"

function seed() {
  const m = fixtureManifest()
  app.manifest = m
  app.flakeIndexes = buildFlakeIndexes(m)
  app.configs = {}
  app.selection = null
}

function loadViaConfig() {
  const config = fixtureConfig()
  config.options[0] = opt(["services", "x", "enable"], {
    customized: true,
    highestPrio: 100,
    declarations: [{ file: `${SELF}/modules/sub/b.nix`, via: "flake.modules.nixos.demo" }],
    definitions: [{ file: `${SELF}/modules/a.nix`, via: "flake.modules.nixos.demo", value: true }],
  })
  config.options[1] = opt(["services", "x", "port"], {
    customized: true,
    highestPrio: 100,
    declarations: [{ file: `${SELF}/modules/sub/b.nix`, via: "flake.modules.nixos.demo" }],
    definitions: [{ file: `${SELF}/modules/a.nix`, via: "flake.modules.nixos.other", value: 1 }],
  })
  app.configs = {
    "nixos/test": {
      data: config,
      indexes: buildConfigIndexes(app.manifest!, config, app.flakeIndexes!),
    },
  }
}

beforeEach(seed)

const mountAt = (path: string[], fn: (host: HTMLElement) => void) =>
  withMount(ModuleOutputDetail, { path, leaf: null }, fn)

describe("module page (leaf via match)", () => {
  test("lists consuming files with declared/set counts, linked to module pages", () => {
    loadViaConfig()
    mountAt(["modules", "nixos", "demo"], (host) => {
      expect(host.querySelector("h2")?.textContent).toBe("modules.nixos.demo")
      expect(host.textContent).toContain("nixos/test")
      const links = [...host.querySelectorAll("button")].map((b) => b.textContent)
      expect(links).toContain("modules/a.nix") // 1 set (demo definition)
      expect(links).toContain("modules/sub/b.nix") // 2 declared
      expect(host.textContent).toContain("2 declared")
      expect(host.textContent).toContain("1 set")
    })
  })

  test("file link selects the module page in that config", () => {
    loadViaConfig()
    mountAt(["modules", "nixos", "demo"], (host) => {
      const link = [...host.querySelectorAll("button")].find(
        (b) => b.textContent === "modules/a.nix",
      )!
      link.click()
      expect(app.selection).toEqual({
        kind: "module",
        configId: "nixos/test",
        moduleId: "self:modules/a.nix",
      })
    })
  })
})

describe("category page (via prefix match)", () => {
  test("aggregates children and lists distinct module names", () => {
    loadViaConfig()
    mountAt(["modules", "nixos"], (host) => {
      // Child modules discovered from the via stamps.
      const links = [...host.querySelectorAll("button")].map((b) => b.textContent)
      expect(links).toContain("demo")
      expect(links).toContain("other")
      // Usage aggregates across both children.
      expect(host.textContent).toContain("modules/a.nix")
    })
  })

  test("child link selects the deeper output path", () => {
    loadViaConfig()
    mountAt(["modules", "nixos"], (host) => {
      const link = [...host.querySelectorAll("button")].find((b) => b.textContent === "demo")!
      link.click()
      expect(app.selection).toEqual({ kind: "output", path: ["modules", "nixos", "demo"] })
    })
  })

  test("top level lists evaluated attr names from outputNames too", () => {
    app.manifest = { ...app.manifest!, outputNames: { modules: ["nixos", "darwin"] } }
    app.flakeIndexes = buildFlakeIndexes(app.manifest)
    mountAt(["modules"], (host) => {
      const links = [...host.querySelectorAll("button")].map((b) => b.textContent)
      expect(links).toContain("nixos")
      expect(links).toContain("darwin")
    })
  })
})

describe("degradation", () => {
  test("unloaded config offers load-in-place", () => {
    mountAt(["modules", "nixos", "demo"], (host) => {
      expect(host.textContent).toContain("load to see usage")
    })
  })

  test("loaded config without via stamps: honest no-provenance note", () => {
    const config = fixtureConfig() // fixture options carry no via
    app.configs = {
      "nixos/test": {
        data: config,
        indexes: buildConfigIndexes(app.manifest!, config, app.flakeIndexes!),
      },
    }
    mountAt(["nixosModules", "demo"], (host) => {
      expect(host.textContent).toContain("No module-system provenance found")
      expect(host.textContent).toContain("not used")
    })
  })
})
