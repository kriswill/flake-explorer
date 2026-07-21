// Component interaction tests: fixture data injected straight into the app
// singleton, components mounted under happy-dom.

import { beforeEach, describe, expect, test } from "bun:test"
import { flushSync, mount, unmount } from "svelte"
import FileList from "../app/components/FileList.svelte"
import ModuleDetail from "../app/components/ModuleDetail.svelte"
import OutputsTree from "../app/components/OutputsTree.svelte"
import { buildConfigIndexes, buildFlakeIndexes } from "../app/lib/indexes"
import { prefs } from "../app/lib/prefs.svelte"
import { app } from "../app/lib/state.svelte"
import { TEXT_DEFAULT_STEP, TEXT_RATIO, TEXT_STEPS, textSizeRem } from "../app/lib/type-scale"
import { fixtureConfig, fixtureManifest } from "./fixtures/data"

function seed() {
  const manifest = fixtureManifest()
  const config = fixtureConfig()
  const fx = buildFlakeIndexes(manifest)
  app.manifest = manifest
  app.flakeIndexes = fx
  app.configs = {
    "nixos/test": { data: config, indexes: buildConfigIndexes(manifest, config, fx) },
  }
  app.selection = null
  app.hover = null
  app.q = ""
  app.showAll = false
  app.expanded.clear()
  app.fileExpanded.clear()
}

function withMount(
  component: unknown,
  props: Record<string, unknown>,
  fn: (host: HTMLElement) => void,
) {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const instance = mount(component as Parameters<typeof mount>[0], { target: host, props })
  try {
    flushSync()
    fn(host)
  } finally {
    void unmount(instance)
    host.remove()
  }
}

beforeEach(seed)

describe("OutputsTree", () => {
  test("renders output categories and expands to a config module tree", () => {
    withMount(OutputsTree, {}, (host) => {
      expect(host.textContent).toContain("nixosConfigurations")
      expect(host.textContent).toContain("packages")

      app.expanded.add("out:nixosConfigurations")
      app.expanded.add("cfg:nixos/test")
      flushSync()
      expect(host.textContent).toContain("test")
      expect(host.textContent).toContain("modules")

      app.expanded.add("dir:self/modules")
      flushSync()
      expect(host.textContent).toContain("a.nix")
    })
  })

  test("transitive inputs sit behind a collapsed disclosure", () => {
    app.manifest!.inputs["nixpkgs/systems"] = {
      name: "nixpkgs/systems",
      nodeKey: "systems",
      type: "github",
      rev: "1234567abcdef00",
      transitive: true,
    }
    withMount(OutputsTree, {}, (host) => {
      const disc = [...host.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("transitive"),
      )!
      expect(disc.textContent).toContain("1")
      // Collapsed by default — the lock node is not in the tree yet.
      expect(host.textContent).not.toContain("nixpkgs/systems")

      disc.click()
      flushSync()
      const row = [...host.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("nixpkgs/systems"),
      )!
      expect(row.textContent).toContain("1234567") // shortPin from rev

      row.click()
      flushSync()
      expect(app.selection).toEqual({ kind: "input", name: "nixpkgs/systems" })
      expect(row.classList.contains("sel")).toBe(true)

      // Toggling again collapses the disclosure.
      disc.click()
      flushSync()
      expect(host.textContent).not.toContain("nixpkgs/systems")
    })
  })

  test("hovered file highlights matching tree nodes", () => {
    withMount(OutputsTree, {}, (host) => {
      app.selection = { kind: "config", configId: "nixos/test" }
      app.expanded.add("out:nixosConfigurations")
      app.expanded.add("cfg:nixos/test")
      app.expanded.add("dir:self/modules")
      app.hover = { kind: "file", fileId: "self:modules/a.nix" }
      flushSync()
      expect(host.querySelectorAll(".row.hl").length).toBeGreaterThan(0)
    })
  })
})

describe("ModuleDetail", () => {
  test("shows Configures and Declares sections with priority chips", () => {
    app.selection = { kind: "module", configId: "nixos/test", moduleId: "self:modules/a.nix" }
    withMount(ModuleDetail, { configId: "nixos/test", moduleId: "self:modules/a.nix" }, (host) => {
      expect(host.textContent).toContain("Configures")
      expect(host.textContent).toContain("services.x.enable")
      expect(host.textContent).toContain("sops.secrets")
      expect(host.textContent).toContain("mkForce") // prio 50 chip
      expect(host.textContent).toContain("declares no options")
    })
  })

  test("declares section hides untouched options until toggled", () => {
    app.selection = { kind: "module", configId: "nixos/test", moduleId: "self:modules/sub/b.nix" }
    withMount(
      ModuleDetail,
      { configId: "nixos/test", moduleId: "self:modules/sub/b.nix" },
      (host) => {
        expect(host.textContent).toContain("services.x.enable")
        expect(host.textContent).not.toContain("services.x.port")
        app.showAll = true
        flushSync()
        expect(host.textContent).toContain("services.x.port")
      },
    )
  })
})

describe("text size", () => {
  const KEY = "flake-explorer:text-step@3"

  test("steps the modular scale, persists, and restores", () => {
    prefs.resetTextSize()
    // The default is in the page shell's static CSS, so it clears the
    // inline override instead of restating it.
    expect(prefs.textSizeName).toBe("M")
    expect(document.documentElement.style.fontSize).toBe("")
    expect(localStorage.getItem(KEY)).toBe("3")

    // One press = one ratio step (1.12rem × 1.125), not a linear nudge.
    prefs.adjustTextStep(1)
    expect(prefs.textStep).toBe(4)
    expect(prefs.textSizeName).toBe("L")
    expect(document.documentElement.style.fontSize).toBe("1.26rem")
    expect(localStorage.getItem(KEY)).toBe("4")

    prefs.adjustTextStep(-2)
    expect(prefs.textSizeName).toBe("S")
    expect(document.documentElement.style.fontSize).toBe("0.996rem")

    prefs.textStep = TEXT_DEFAULT_STEP // simulate a fresh session
    prefs.initTextSize() // restores the saved step
    expect(prefs.textSizeName).toBe("S")
  })

  test("clamps at both ends of the scale", () => {
    prefs.setTextStep(99)
    expect(prefs.textStep).toBe(TEXT_STEPS.length - 1)
    expect(prefs.textSizeName).toBe("XXL")

    prefs.setTextStep(-99)
    expect(prefs.textStep).toBe(0)
    expect(prefs.textSizeName).toBe("XXS")

    // Sizes stay geometric around the default: n steps out is ratio^n.
    expect(textSizeRem(TEXT_DEFAULT_STEP)).toBe(1.12)
    expect(textSizeRem(TEXT_DEFAULT_STEP + 1)).toBe(Math.round(1.12 * TEXT_RATIO * 1000) / 1000)
  })

  test("an unset or junk saved value falls back to the default step", () => {
    // getItem returns null and Number(null) is 0 — a real step ("XXS") — so
    // "absent" must not be read as a number.
    prefs.setTextStep(0) // moves off the default (and persists), then:
    localStorage.removeItem(KEY)
    prefs.initTextSize()
    expect(prefs.textSizeName).toBe("M")

    localStorage.setItem(KEY, "not-a-number")
    prefs.initTextSize()
    expect(prefs.textSizeName).toBe("M")
  })
})

describe("theme", () => {
  test("persists the chosen theme; saved choice beats the OS preference", () => {
    prefs.setTheme(1)
    expect(prefs.themeIndex).toBe(1)
    expect(localStorage.getItem("flake-explorer:theme@1")).toBe("1")
    expect(document.documentElement.style.getPropertyValue("color-scheme")).toBe("dark")

    prefs.themeIndex = 0 // simulate a fresh session
    prefs.initTheme(false) // OS prefers light, but the saved choice wins
    expect(prefs.themeIndex).toBe(1)

    prefs.setTheme(99) // out of bounds — ignored
    expect(prefs.themeIndex).toBe(1)

    localStorage.removeItem("flake-explorer:theme@1")
    prefs.initTheme(false) // nothing saved — falls back to the OS preference
    expect(prefs.themeIndex).toBe(0)
  })
})

describe("pane widths", () => {
  test("clamps, persists on save, and restores", () => {
    prefs.resetPanes()
    prefs.setPane("left", 5000)
    expect(prefs.paneLeft).toBe(640) // clamped to max
    prefs.setPane("right", 10)
    expect(prefs.paneRight).toBe(200) // clamped to min
    prefs.savePanes()

    prefs.paneLeft = 0
    prefs.paneRight = 0
    prefs.initPanes()
    expect(prefs.paneLeft).toBe(640)
    expect(prefs.paneRight).toBe(200)

    prefs.resetPanes()
    expect(prefs.paneLeft).toBe(280)
    expect(prefs.paneRight).toBe(340)
  })
})

describe("FileList", () => {
  test("renders groups as folder trees; files hidden until folder expands", () => {
    withMount(FileList, {}, (host) => {
      expect(host.textContent).toContain("/etc/test") // self group header
      expect(host.textContent).toContain("sops-nix") // input group from config
      expect(host.textContent).toContain("modules/") // grey folder row
      expect(host.textContent).not.toContain("a.nix") // collapsed by default
      app.fileExpanded.add("fdir:self/modules")
      flushSync()
      expect(host.textContent).toContain("a.nix")
      expect(host.textContent).toContain("sub/") // nested folder now visible
    })
  })

  test("selecting a module on the left auto-expands and highlights its file", () => {
    withMount(FileList, {}, (host) => {
      app.select({ kind: "module", configId: "nixos/test", moduleId: "self:modules/sub/b.nix" })
      flushSync()
      expect(app.fileExpanded.has("fdir:self/modules")).toBe(true)
      expect(app.fileExpanded.has("fdir:self/modules/sub")).toBe(true)
      const row = host.querySelector(".row.modsel")
      expect(row?.textContent).toContain("b.nix")
    })
  })

  test("import-related files get tinted when a file is selected", () => {
    withMount(FileList, {}, (host) => {
      app.fileExpanded.add("fdir:self/modules")
      app.fileExpanded.add("fdir:self/modules/sub")
      app.selection = { kind: "file", fileId: "self:lib/c.nix" }
      flushSync()
      // a.nix and sub/b.nix import c.nix — both rows carry .rel
      expect(host.querySelectorAll(".row.rel").length).toBe(2)
    })
  })

  test("filter hides non-matching subtrees and auto-reveals matches", () => {
    withMount(FileList, {}, (host) => {
      app.q = "sub/b"
      flushSync()
      expect(host.textContent).toContain("b.nix") // revealed without manual expand
      expect(host.textContent).not.toContain("a.nix")
      expect(host.textContent).not.toContain("lib/") // subtree without matches hidden
      expect(host.textContent).not.toContain("sops-nix") // group without matches hidden
    })
  })
})
