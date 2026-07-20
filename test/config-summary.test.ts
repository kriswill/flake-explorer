// ConfigSummary: the configuration landing page — stats, customization
// hotspots, per-input module counts, and compare links.

import { beforeEach, describe, expect, test } from "bun:test"
import ConfigSummary from "../app/components/ConfigSummary.svelte"
import { buildConfigIndexes, buildFlakeIndexes } from "../app/lib/indexes"
import { app } from "../app/lib/state.svelte"
import { fixtureConfig, fixtureManifest } from "./fixtures/data"
import { withMount } from "./helpers"

const ID = "nixos/test"

function seed() {
  const m = fixtureManifest()
  m.configurations = [
    ...m.configurations,
    {
      id: "darwin/mini",
      kind: "darwin",
      name: "mini",
      dataFile: "config/darwin.mini.json",
      status: "pending",
    },
  ]
  app.manifest = m
  app.flakeIndexes = buildFlakeIndexes(m)
  app.configs = {}
  app.selection = null
  app.expanded.clear()
}

function loadConfig() {
  const config = fixtureConfig()
  app.configs = {
    [ID]: { data: config, indexes: buildConfigIndexes(app.manifest!, config, app.flakeIndexes!) },
  }
}

const mountSummary = (fn: (host: HTMLElement) => void) =>
  withMount(ConfigSummary, { configId: ID }, fn)

beforeEach(seed)

describe("stats", () => {
  test("counts options, customizations, and contributing files", () => {
    loadConfig()
    mountSummary((host) => {
      expect(host.textContent).toContain("3 options, 2 customized, 3 contributing files")
    })
  })

  test("an unloaded config renders only the heading", () => {
    mountSummary((host) => {
      expect(host.querySelector("h2")?.textContent).toBe(ID)
      expect(host.querySelector("section")).toBeNull()
    })
  })
})

describe("hotspots", () => {
  test("lists the busiest areas with their customized counts", () => {
    loadConfig()
    mountSummary((host) => {
      expect(host.textContent).toContain("Most customized areas")
      // modules/a.nix defines 2 of the fixture's customized options.
      const links = [...host.querySelectorAll("button")].map((b) => b.textContent)
      expect(links).toContain("a.nix")
      expect(host.textContent).toContain("2 set")
    })
  })

  test("a file hotspot navigates to its module page", () => {
    loadConfig()
    mountSummary((host) => {
      const link = [...host.querySelectorAll("button")].find((b) => b.textContent === "a.nix")!
      link.click()
      expect(app.selection).toEqual({
        kind: "module",
        configId: ID,
        moduleId: "self:modules/a.nix",
      })
    })
  })
})

describe("inputs", () => {
  test("counts module files per input and links to the input page", () => {
    loadConfig()
    mountSummary((host) => {
      expect(host.textContent).toContain("Modules by input")
      const link = [...host.querySelectorAll("button")].find((b) => b.textContent === "sops-nix")!
      expect(link).toBeDefined()
      link.click()
      expect(app.selection).toEqual({ kind: "input", name: "sops-nix" })
    })
  })
})

describe("compare links", () => {
  test("each sibling configuration opens a diff", () => {
    loadConfig()
    mountSummary((host) => {
      expect(host.textContent).toContain("Compare with")
      const link = [...host.querySelectorAll("button")].find(
        (b) => b.textContent === "darwin/mini",
      )!
      link.click()
      expect(app.selection).toEqual({ kind: "diff", a: ID, b: "darwin/mini" })
    })
  })

  test("a lone configuration gets no compare section", () => {
    app.manifest = { ...app.manifest!, configurations: [app.manifest!.configurations[0]!] }
    app.flakeIndexes = buildFlakeIndexes(app.manifest)
    loadConfig()
    mountSummary((host) => {
      expect(host.textContent).not.toContain("Compare with")
    })
  })
})
