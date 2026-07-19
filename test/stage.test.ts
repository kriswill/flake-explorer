// Stage.svelte: the central dispatch component picking a detail view (or
// the flake-overview fallback) from app.selection. Nothing mounted it
// directly before the package-detail work, so its whole branch matrix was
// previously untested — this covers every branch, not just the package one.

import { beforeEach, describe, expect, test } from "bun:test"
import Stage from "../app/components/Stage.svelte"
import { buildConfigIndexes, buildFlakeIndexes } from "../app/lib/indexes"
import { app } from "../app/lib/state.svelte"
import { fixtureConfig, fixtureManifest } from "./fixtures/data"
import { withMount } from "./helpers"

function seed() {
  const m = fixtureManifest()
  app.manifest = m
  app.flakeIndexes = buildFlakeIndexes(m)
  app.configs = {}
  app.packages = {}
  app.selection = null
  app.expanded.clear()
  app.fileExpanded.clear()
}

function loadTestConfig() {
  const m = app.manifest!
  const config = fixtureConfig()
  app.configs = {
    "nixos/test": { data: config, indexes: buildConfigIndexes(m, config, app.flakeIndexes!) },
  }
}

beforeEach(seed)

describe("Stage", () => {
  test("module selection renders ModuleDetail", () => {
    loadTestConfig()
    app.selection = { kind: "module", configId: "nixos/test", moduleId: "self:modules/a.nix" }
    withMount(Stage, {}, (host) => {
      expect(host.querySelector("h2")?.textContent).toBe("modules/a.nix")
    })
  })

  test("file selection renders FileDetail", () => {
    app.selection = { kind: "file", fileId: "self:lib/c.nix" }
    withMount(Stage, {}, (host) => {
      expect(host.querySelector("h2")?.textContent).toBe("lib/c.nix")
    })
  })

  test("input selection renders InputDetail", () => {
    app.selection = { kind: "input", name: "sops-nix" }
    withMount(Stage, {}, (host) => {
      expect(host.querySelector("h2")?.textContent).toBe("inputs.sops-nix")
    })
  })

  test("output selection matching a package renders PackageDetail", () => {
    app.selection = { kind: "output", path: ["packages", "x86_64-linux", "hello"] }
    withMount(Stage, {}, (host) => {
      expect(host.textContent).toContain("Evaluating package")
    })
  })

  test("output selection, generic leaf: shows type/name/description", () => {
    app.selection = { kind: "output", path: ["nixosConfigurations", "test"] }
    withMount(Stage, {}, (host) => {
      expect(host.querySelector("h2")?.textContent).toBe("nixosConfigurations.test")
      expect(host.textContent).toContain("NixOS configuration")
    })
  })

  test("output selection, omitted node: shows the re-extract hint", () => {
    // fixtureManifest already has packages.aarch64-darwin: {kind:"omitted"}.
    app.selection = { kind: "output", path: ["packages", "aarch64-darwin"] }
    withMount(Stage, {}, (host) => {
      expect(host.textContent).toContain("Not evaluated for this system")
    })
  })

  test("output selection, unclassifiable node: generic fallback message", () => {
    // fixtureManifest already has a top-level weird: {kind:"unknown"}.
    app.selection = { kind: "output", path: ["weird"] }
    withMount(Stage, {}, (host) => {
      expect(host.textContent).toContain("could not classify this output")
    })
  })

  test("config selection with options loaded shows the summary", () => {
    loadTestConfig()
    app.selection = { kind: "config", configId: "nixos/test" }
    withMount(Stage, {}, (host) => {
      expect(host.textContent).toContain("3 options, 2 customized")
    })
  })

  test("config selection, still loading", () => {
    app.configs = { "nixos/test": "loading" }
    app.selection = { kind: "config", configId: "nixos/test" }
    withMount(Stage, {}, (host) => {
      expect(host.textContent).toContain("Extracting / loading options")
    })
  })

  test("config selection, error slot (extraction failed after being requested)", () => {
    app.configs = { "nixos/test": { error: "boom: eval failed" } }
    app.selection = { kind: "config", configId: "nixos/test" }
    withMount(Stage, {}, (host) => {
      expect(host.textContent).toContain("boom: eval failed")
    })
  })

  test("config selection, ref-level error (no slot requested yet)", () => {
    app.manifest = {
      ...app.manifest!,
      configurations: [
        { ...app.manifest!.configurations[0]!, status: "error", error: "nix eval failed" },
      ],
    }
    app.selection = { kind: "config", configId: "nixos/test" }
    withMount(Stage, {}, (host) => {
      expect(host.textContent).toContain("nix eval failed")
    })
  })

  test("no selection: flake overview, legend, and extraction warnings", () => {
    app.manifest = { ...app.manifest!, warnings: ["something happened"] }
    withMount(Stage, {}, (host) => {
      expect(host.textContent).toContain("test flake")
      expect(host.textContent).toContain("1 extraction warnings")
      expect(host.querySelector("details")).not.toBeNull()
      host.querySelector("summary")!.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    })
  })

  test("no selection, no warnings: overview renders without a details element", () => {
    withMount(Stage, {}, (host) => {
      expect(host.textContent).toContain("test flake")
      expect(host.querySelector("details")).toBeNull()
    })
  })
})
