// FileDetail.svelte: the file-detail panel (source view, git info, imports/
// importedBy, and the per-config "customizes"/declares view). Effect-driven
// loadFileContent is exercised the same careful way input-detail.test.ts
// is — fetch mocked or an embed pre-injected BEFORE mount, never after,
// to avoid racing the effect's own in-flight load.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { flushSync, mount, unmount } from "svelte"
import FileDetail from "../app/components/FileDetail.svelte"
import { buildConfigIndexes, buildFlakeIndexes } from "../app/lib/indexes"
import { app } from "../app/lib/state.svelte"
import { fixtureConfig, fixtureManifest } from "./fixtures/data"
import { buttonsWithText, withMount } from "./helpers"

const injected: HTMLElement[] = []
function injectData(name: string, value: unknown) {
  const el = document.createElement("script")
  el.type = "application/json"
  el.id = `data:${name}`
  el.textContent = JSON.stringify(value)
  document.head.appendChild(el)
  injected.push(el)
}

function seed() {
  const m = fixtureManifest()
  app.manifest = m
  app.flakeIndexes = buildFlakeIndexes(m)
  app.configs = {}
  app.fileContents = {}
  app.selection = null
  // A few tests click module/file links, which populate this via revealFile —
  // clear it so a later test file sharing the `app` singleton starts clean.
  app.fileExpanded.clear()
}

beforeEach(seed)

afterEach(() => {
  for (const el of injected.splice(0)) el.remove()
})

/** Loads "nixos/test" so configView resolves for files fixtureConfig references. */
function loadTestConfig() {
  const indexes = buildConfigIndexes(app.manifest!, fixtureConfig(), app.flakeIndexes!)
  app.configs = { "nixos/test": { data: fixtureConfig(), indexes } }
}

describe("FileDetail", () => {
  test("self file with no config loaded: importedBy section, no modulechip/InputProvenance", async () => {
    injectData(`file/${encodeURIComponent("self:lib/c.nix")}`, { text: "x: x", tokens: [] })
    const host = document.createElement("div")
    document.body.appendChild(host)
    const instance = mount(FileDetail, { target: host, props: { fileId: "self:lib/c.nix" } })
    try {
      await Bun.sleep(0)
      flushSync()
      expect(host.querySelector("h2")?.textContent).toBe("lib/c.nix")
      expect(host.querySelector(".modulechip")).toBeNull()
      expect(host.querySelector(".prov")).toBeNull() // InputProvenance only for input-origin
      // Both a.nix and sub/b.nix import c.nix (fixtureManifest importEdges).
      expect(host.textContent).toContain("imported by")
      expect(host.textContent).toContain("2")
      expect(host.textContent).toContain("Load a configuration on the left")
      expect(host.querySelector(".src")?.textContent).toContain("x: x")
    } finally {
      void unmount(instance)
      host.remove()
    }
  })

  test("git info renders a last-commit block; copy button copies the commit hash", async () => {
    const origClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard")
    const copied: { text: string | null } = { text: null }
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (t: string) => {
          copied.text = t
        },
      },
      configurable: true,
    })
    injectData(`file/${encodeURIComponent("self:modules/a.nix")}`, { text: "{ }", tokens: [] })
    const host = document.createElement("div")
    document.body.appendChild(host)
    const instance = mount(FileDetail, { target: host, props: { fileId: "self:modules/a.nix" } })
    try {
      await Bun.sleep(0)
      flushSync()
      expect(host.textContent).toContain("add module a")
      const copyBtn = buttonsWithText(host, "copy")[0]!
      copyBtn.click()
      await Bun.sleep(0)
      flushSync()
      expect(copied.text).toBe("1234567890abcdef")
      expect(copyBtn.textContent).toBe("copied")
    } finally {
      if (origClipboard) Object.defineProperty(navigator, "clipboard", origClipboard)
      else delete (navigator as { clipboard?: unknown }).clipboard
      void unmount(instance)
      host.remove()
    }
  })

  test("a virtual (non-store) declaration path skips loading and shows the explainer", () => {
    app.manifest = {
      ...fixtureManifest(),
      files: [
        ...fixtureManifest().files,
        {
          id: "self:virtual",
          relPath: "virtual",
          origin: { kind: "self" },
          storePath: "lib/modules.nix",
        },
      ],
    }
    withMount(FileDetail, { fileId: "self:virtual" }, (host) => {
      expect(host.textContent).toContain("virtual path")
      expect(host.textContent).toContain("lib/modules.nix")
      expect(host.querySelector(".src")).toBeNull()
    })
  })

  test("loading, then a failed fetch (first line only) with a retry that recovers", async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch
    const host = document.createElement("div")
    document.body.appendChild(host)
    const instance = mount(FileDetail, { target: host, props: { fileId: "self:lib/c.nix" } })
    try {
      flushSync()
      expect(host.textContent).toContain("loading source")
      await Bun.sleep(0)
      flushSync()
      expect(host.textContent).toContain("HTTP 500")

      injectData(`file/${encodeURIComponent("self:lib/c.nix")}`, { text: "recovered", tokens: [] })
      buttonsWithText(host, "retry")[0]!.click()
      await Bun.sleep(0)
      flushSync()
      expect(host.querySelector(".src")?.textContent).toContain("recovered")
    } finally {
      globalThis.fetch = origFetch
      void unmount(instance)
      host.remove()
    }
  })

  test("input-origin declaration file: InputProvenance renders, declares-only shows no customized values", async () => {
    loadTestConfig()
    const fileId = "input:sops-nix:modules/sops/default.nix"
    injectData(`file/${encodeURIComponent(fileId)}`, { text: "{ }", tokens: [] })
    const host = document.createElement("div")
    document.body.appendChild(host)
    const instance = mount(FileDetail, { target: host, props: { fileId } })
    try {
      await Bun.sleep(0)
      flushSync()
      expect(host.querySelector(".prov")).not.toBeNull()
      expect(host.textContent).toContain("No customized option values")
    } finally {
      void unmount(instance)
      host.remove()
    }
  })

  test("a self file that defines options: modulechip navigates, customizes lists the options", async () => {
    loadTestConfig()
    const fileId = "self:modules/a.nix"
    injectData(`file/${encodeURIComponent(fileId)}`, { text: "{ }", tokens: [] })
    const host = document.createElement("div")
    document.body.appendChild(host)
    const instance = mount(FileDetail, { target: host, props: { fileId } })
    try {
      await Bun.sleep(0)
      flushSync()
      expect(host.textContent).toContain("customizes in nixos/test")
      expect(host.textContent).toContain("services.x.enable")
      expect(host.textContent).toContain("sops.secrets")

      const chip = buttonsWithText(host, "module")[0]!
      chip.click()
      flushSync()
      expect(app.selection).toEqual({ kind: "module", configId: "nixos/test", moduleId: fileId })
    } finally {
      void unmount(instance)
      host.remove()
    }
  })

  test("imports/importedBy links navigate to the target file", async () => {
    injectData(`file/${encodeURIComponent("self:modules/a.nix")}`, { text: "{ }", tokens: [] })
    const host = document.createElement("div")
    document.body.appendChild(host)
    const instance = mount(FileDetail, { target: host, props: { fileId: "self:modules/a.nix" } })
    try {
      await Bun.sleep(0)
      flushSync()
      expect(host.textContent).toContain("imports")
      const link = buttonsWithText(host, "lib/c.nix")[0]!
      link.click()
      flushSync()
      expect(app.selection).toEqual({ kind: "file", fileId: "self:lib/c.nix" })
    } finally {
      void unmount(instance)
      host.remove()
    }
  })
})
