// OptionDetail: the option page — load states, missing-option honesty
// (degraded-chunk warnings), declarer links with line numbers, definitions
// in merge order with priority chips, and cross-config navigation.

import { beforeEach, describe, expect, test } from "bun:test"
import OptionDetail from "../app/components/OptionDetail.svelte"
import { buildConfigIndexes, buildFlakeIndexes } from "../app/lib/indexes"
import { app } from "../app/lib/state.svelte"
import { PRIO } from "../src/schema"
import { fixtureConfig, fixtureManifest, opt, SELF, SOPS } from "./fixtures/data"
import { withMount } from "./helpers"

function seed() {
  const m = fixtureManifest()
  app.manifest = m
  app.flakeIndexes = buildFlakeIndexes(m)
  app.configs = {}
  app.selection = null
}

function loadTestConfig(config = fixtureConfig()) {
  app.configs = {
    ...app.configs,
    [config.id]: {
      data: config,
      indexes: buildConfigIndexes(app.manifest!, config, app.flakeIndexes!),
    },
  }
}

const mountOpt = (loc: string[], fn: (host: HTMLElement) => void, configId = "nixos/test") =>
  withMount(OptionDetail, { configId, loc }, fn)

beforeEach(seed)

describe("load states", () => {
  test("no slot yet / loading slot shows the extraction message", () => {
    mountOpt(["services", "x", "enable"], (host) => {
      expect(host.textContent).toContain("Extracting / loading options")
    })
    app.configs = { "nixos/test": "loading" }
    mountOpt(["services", "x", "enable"], (host) => {
      expect(host.textContent).toContain("Extracting / loading options")
    })
  })

  test("error slot shows the error with a retry button", () => {
    app.configs = { "nixos/test": { error: "boom: eval failed" } }
    mountOpt(["services", "x", "enable"], (host) => {
      expect(host.textContent).toContain("boom: eval failed")
      expect(host.textContent).toContain("retry")
    })
  })

  test("permanent errors (static export) hide retry", () => {
    app.configs = { "nixos/test": { error: "not included in this export", permanent: true } }
    mountOpt(["services", "x", "enable"], (host) => {
      expect(host.textContent).toContain("not included")
      expect(host.textContent).not.toContain("retry")
    })
  })
})

describe("missing option", () => {
  test("plain absence", () => {
    loadTestConfig()
    mountOpt(["no", "such", "option"], (host) => {
      expect(host.textContent).toContain("Not present in this configuration")
    })
  })

  test("surfaces degraded-chunk warnings matching the loc prefix", () => {
    app.manifest = {
      ...app.manifest!,
      warnings: [
        "[cached] nixos/test options.pkgs: values+descriptions skipped (eval error at full detail)",
        "nixos/test options.services.broken.thing: extraction failed — error: boom",
        "nixos/test options.unrelated: extraction failed — error: other",
      ],
    }
    app.flakeIndexes = buildFlakeIndexes(app.manifest)
    loadTestConfig()
    mountOpt(["pkgs", "foo", "package"], (host) => {
      expect(host.textContent).toContain("options.pkgs: values+descriptions skipped")
      expect(host.textContent).not.toContain("unrelated")
    })
  })
})

describe("found option", () => {
  test("renders type, description, default, declarer with line, and merged value", () => {
    const config = fixtureConfig()
    config.options[0] = opt(["services", "x", "enable"], {
      customized: true,
      highestPrio: PRIO.plain,
      type: "boolean",
      description: "Whether to enable x.",
      value: true,
      default: false,
      declarations: [{ file: `${SELF}/modules/sub/b.nix`, line: 12, column: 3 }],
      definitions: [{ file: `${SELF}/modules/a.nix`, value: true }],
    })
    loadTestConfig(config)
    mountOpt(["services", "x", "enable"], (host) => {
      expect(host.querySelector("h2")?.textContent).toBe("services.x.enable")
      expect(host.textContent).toContain("boolean")
      expect(host.textContent).toContain("Whether to enable x.")
      expect(host.textContent).toContain("modules/sub/b.nix:12")
      expect(host.textContent).toContain("Final merged value")
      // Definition site links to its module page.
      const links = [...host.querySelectorAll("button")].map((b) => b.textContent)
      expect(links).toContain("modules/a.nix")
    })
  })

  test("declarer link navigates to the declaring module's page", () => {
    loadTestConfig()
    mountOpt(["sops", "secrets"], (host) => {
      // sops.secrets is declared by the sops-nix input module.
      const link = [...host.querySelectorAll("button")].find((b) =>
        b.textContent?.startsWith("modules/sops/default.nix"),
      )!
      expect(link).toBeDefined()
      link.click()
      expect(app.selection).toMatchObject({
        kind: "module",
        configId: "nixos/test",
        moduleId: "input:sops-nix:modules/sops/default.nix",
      })
    })
  })

  test("definition chips fall back to the option's highestPrio (filterOverrides semantics)", () => {
    const config = fixtureConfig()
    config.options[2] = opt(["sops", "secrets"], {
      customized: true,
      highestPrio: PRIO.mkForce,
      declarations: [{ file: `${SOPS}/modules/sops/default.nix` }],
      definitions: [{ file: `${SELF}/modules/a.nix`, value: {} }],
    })
    loadTestConfig(config)
    mountOpt(["sops", "secrets"], (host) => {
      const chips = [...host.querySelectorAll(".chip")].map((c) => c.textContent)
      expect(chips.filter((c) => c === "mkForce").length).toBeGreaterThanOrEqual(2) // header + definition
    })
  })

  test("a definition's own prio wins over highestPrio", () => {
    const config = fixtureConfig()
    config.options[0] = opt(["services", "x", "enable"], {
      customized: true,
      highestPrio: PRIO.plain,
      definitions: [{ file: `${SELF}/modules/a.nix`, value: true, prio: PRIO.mkDefault }],
    })
    loadTestConfig(config)
    mountOpt(["services", "x", "enable"], (host) => {
      expect([...host.querySelectorAll(".chip")].map((c) => c.textContent)).toContain("mkDefault")
    })
  })

  test("skipped and errored definition values render honestly", () => {
    const config = fixtureConfig()
    config.options[0] = opt(["services", "x", "enable"], {
      customized: true,
      highestPrio: PRIO.plain,
      valueSkipped: true,
      definitions: [
        { file: `${SELF}/modules/a.nix`, valueSkipped: true },
        { file: `${SELF}/modules/sub/b.nix`, valueError: true },
      ],
    })
    loadTestConfig(config)
    mountOpt(["services", "x", "enable"], (host) => {
      expect(host.textContent).toContain("value skipped")
      expect(host.textContent).toContain("⚠ value failed to evaluate")
    })
  })

  test("package-typed names render as chips for value, definitions, and default", () => {
    const config = fixtureConfig()
    config.options[0] = opt(["environment", "systemPackages"], {
      customized: true,
      highestPrio: PRIO.plain,
      type: "list of package",
      valueSkipped: true,
      valueNames: ["hello-2.12", "rg-14.1"],
      defaultNames: [],
      definitions: [
        { file: `${SELF}/modules/a.nix`, valueSkipped: true, valueNames: ["hello-2.12"] },
        { file: `${SELF}/modules/sub/b.nix`, valueSkipped: true, valueNames: ["rg-14.1"] },
      ],
    })
    loadTestConfig(config)
    mountOpt(["environment", "systemPackages"], (host) => {
      const nameLists = [...host.querySelectorAll(".names")].map((ul) =>
        [...ul.querySelectorAll("li")].map((li) => li.textContent),
      )
      // Two definitions + the final merged value, in document order.
      expect(nameLists).toEqual([["hello-2.12"], ["rg-14.1"], ["hello-2.12", "rg-14.1"]])
      // Empty default names say so instead of faking a skip.
      expect(host.textContent).toContain("(no packages)")
      expect(host.textContent).not.toContain("(value skipped")
    })
  })

  test("undefined option says so instead of an empty definitions list", () => {
    const config = fixtureConfig()
    config.options[1] = opt(["services", "x", "port"], {
      isDefined: false,
      type: "signed integer",
      default: 8080,
      declarations: [{ file: `${SELF}/modules/sub/b.nix` }],
    })
    loadTestConfig(config)
    mountOpt(["services", "x", "port"], (host) => {
      expect(host.textContent).toContain("Not set anywhere")
    })
  })

  test("other configurations link to the same loc and annotate loaded ones", () => {
    app.manifest = {
      ...app.manifest!,
      configurations: [
        ...app.manifest!.configurations,
        {
          id: "darwin/mini",
          kind: "darwin",
          name: "mini",
          dataFile: "config/darwin.mini.json",
          status: "pending",
        },
      ],
    }
    app.flakeIndexes = buildFlakeIndexes(app.manifest)
    loadTestConfig()
    mountOpt(["services", "x", "enable"], (host) => {
      expect(host.textContent).toContain("Other configurations")
      const link = [...host.querySelectorAll("button")].find(
        (b) => b.textContent === "darwin/mini",
      )!
      // Unloaded sibling: no presence annotation, link fires an option selection.
      link.click()
      expect(app.selection).toMatchObject({
        kind: "option",
        configId: "darwin/mini",
        loc: ["services", "x", "enable"],
      })
    })
  })
})
