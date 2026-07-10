// OutputBranch (generic outputs subtree) and the OutputsTree paths not
// covered by app.test.ts: inputs section, grafts, outputNames fallback,
// unevaluated notes, and config slot loading/error states.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { flushSync, mount, unmount } from "svelte"
import OutputBranch from "../app/components/OutputBranch.svelte"
import OutputsTree from "../app/components/OutputsTree.svelte"
import { buildFlakeIndexes } from "../app/lib/indexes"
import { app } from "../app/lib/state.svelte"
import type { OutputNode } from "../src/schema"
import { fixtureConfig, fixtureManifest } from "./fixtures/data"
import { buttonsWithText, withMount } from "./helpers"

type Attrset = Extract<OutputNode, { kind: "attrset" }>

function seed(mutate?: (m: ReturnType<typeof fixtureManifest>) => void) {
  const manifest = fixtureManifest()
  mutate?.(manifest)
  app.manifest = manifest
  app.flakeIndexes = buildFlakeIndexes(manifest)
  app.configs = {}
  app.selection = null
  app.hover = null
  app.q = ""
  app.showAll = false
  app.expanded.clear()
}

beforeEach(() => seed())

const injected: HTMLElement[] = []
afterEach(() => {
  for (const el of injected.splice(0)) el.remove()
})

function injectConfigData() {
  const el = document.createElement("script")
  el.type = "application/json"
  el.id = "data:config/nixos.test.json"
  el.textContent = JSON.stringify(fixtureConfig())
  document.head.appendChild(el)
  injected.push(el)
}

describe("OutputBranch", () => {
  const packagesNode = () => {
    const outputs = fixtureManifest().outputs as Attrset
    return outputs.children.packages as Attrset
  }

  test("expands nested attrsets on click and collapses on a second click", () => {
    withMount(OutputBranch, { node: packagesNode(), path: ["packages"], depth: 1 }, (host) => {
      expect(host.textContent).toContain("x86_64-linux")
      expect(host.textContent).not.toContain("hello")

      buttonsWithText(host, "x86_64-linux")[0]!.click()
      flushSync()
      expect(app.expanded.has("out:packages.x86_64-linux")).toBe(true)
      expect(host.textContent).toContain("hello")
      expect(host.textContent).toContain("package") // leaf type column

      buttonsWithText(host, "x86_64-linux")[0]!.click()
      flushSync()
      expect(host.textContent).not.toContain("hello")
    })
  })

  test("clicking a leaf selects the output path and marks the row", () => {
    app.expanded.add("out:packages.x86_64-linux")
    withMount(OutputBranch, { node: packagesNode(), path: ["packages"], depth: 1 }, (host) => {
      buttonsWithText(host, "hello")[0]!.click()
      flushSync()
      expect(app.selection).toEqual({
        kind: "output",
        path: ["packages", "x86_64-linux", "hello"],
      })
      expect(buttonsWithText(host, "hello")[0]!.classList.contains("sel")).toBe(true)
    })
  })

  test("omitted and unknown children render dimmed with a kind note", () => {
    const node = packagesNode()
    node.children.mystery = { kind: "unknown" }
    withMount(OutputBranch, { node, path: ["packages"], depth: 1 }, (host) => {
      const darwin = buttonsWithText(host, "aarch64-darwin")[0]!
      expect(darwin.textContent).toContain("(other system)")
      expect(darwin.classList.contains("dim")).toBe(true)
      expect(buttonsWithText(host, "mystery")[0]!.textContent).toContain("(unevaluated)")
    })
  })
})

describe("OutputsTree", () => {
  test("flake path, description fallback, and input selection", () => {
    seed((m) => {
      m.flake.description = undefined
    })
    withMount(OutputsTree, {}, (host) => {
      expect(host.querySelector(".path")?.textContent).toBe("test") // /etc/test → test
      expect(host.textContent).toContain("(none)")

      const input = buttonsWithText(host, "sops-nix")[0]!
      expect(input.textContent).toContain("abcdef1") // shortPin
      input.click()
      flushSync()
      expect(app.selection).toEqual({ kind: "input", name: "sops-nix" })
      expect(buttonsWithText(host, "sops-nix")[0]!.classList.contains("sel")).toBe(true)
    })
  })

  test("grafted namespace: badge, inherited note, and added-key selection", () => {
    seed((m) => {
      m.grafts = [{ output: "lib", input: "nixpkgs", added: ["myHelper"], inherited: 42 }]
    })
    withMount(OutputsTree, {}, (host) => {
      expect(host.textContent).toContain("nixpkgs.lib +1")
      app.expanded.add("out:lib")
      flushSync()
      expect(host.textContent).toContain("extends nixpkgs.lib · 42 inherited keys hidden")

      buttonsWithText(host, "myHelper")[0]!.click()
      flushSync()
      expect(app.selection).toEqual({ kind: "output", path: ["lib", "myHelper"] })
      expect(buttonsWithText(host, "myHelper")[0]!.classList.contains("sel")).toBe(true)
    })
  })

  test("unknown output falls back to eval'd attr names, else an (unevaluated) note", () => {
    seed((m) => {
      const outputs = m.outputs as Attrset
      outputs.children.overlays = { kind: "unknown" }
      m.outputNames = { overlays: ["default", "stable"] }
    })
    withMount(OutputsTree, {}, (host) => {
      app.expanded.add("out:overlays")
      app.expanded.add("out:weird") // unknown with no names
      flushSync()
      expect(host.textContent).toContain("stable")
      expect(host.textContent).toContain("(unevaluated)")

      buttonsWithText(host, "default")[0]!.click()
      flushSync()
      expect(app.selection).toEqual({ kind: "output", path: ["overlays", "default"] })
    })
  })

  test("config slots: loading note, error note, and a successful retry", async () => {
    injectConfigData()
    app.expanded.add("out:nixosConfigurations")
    app.expanded.add("cfg:nixos/test")
    app.configs = { "nixos/test": "loading" }

    const host = document.createElement("div")
    document.body.appendChild(host)
    const instance = mount(OutputsTree, { target: host })
    try {
      flushSync()
      expect(host.textContent).toContain("loading options…")

      app.configs = { "nixos/test": { error: "boom: eval failed\nsecond line" } }
      flushSync()
      expect(host.textContent).toContain("boom: eval failed")
      expect(host.textContent).not.toContain("second line") // first line only

      buttonsWithText(host, "retry")[0]!.click()
      // retryConfig → loadConfig resolves from the injected data tag.
      await Bun.sleep(0)
      flushSync()
      expect(host.textContent).not.toContain("boom")
      // loaded badge = customized option count (2) next to the config name
      expect(host.querySelector(".row.cfg .badge")?.textContent).toBe("2")
    } finally {
      void unmount(instance)
      host.remove()
    }
  })
})
