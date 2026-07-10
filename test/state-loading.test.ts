// Data-loading and routing paths of the app singleton: loadManifest/
// loadConfig/loadFileContent resolve through loadJson's embedded-tag mode
// (script tags injected into happy-dom), so no network is involved.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { buildFlakeIndexes } from "../app/lib/indexes"
import { app, loadedConfig } from "../app/lib/state.svelte"
import { SCHEMA_VERSION } from "../src/schema"
import { fixtureConfig, fixtureManifest } from "./fixtures/data"

const injected = new Map<string, HTMLElement>()

function injectData(name: string, value: unknown) {
  const el = document.createElement("script")
  el.type = "application/json"
  el.id = `data:${name}`
  el.textContent = JSON.stringify(value)
  document.head.appendChild(el)
  injected.set(name, el)
}

beforeEach(() => {
  app.manifest = null
  app.manifestError = null
  app.flakeIndexes = null
  app.configs = {}
  app.fileContents = {}
  app.selection = null
  app.q = ""
  app.showAll = false
  app.expanded.clear()
  app.fileExpanded.clear()
})

afterEach(() => {
  for (const el of injected.values()) el.remove()
  injected.clear()
})

describe("loadManifest", () => {
  test("loads, indexes, and follows a deep link decoded before it arrived", async () => {
    injectData("manifest.json", fixtureManifest())
    injectData("config/nixos.test.json", fixtureConfig())
    // Deep link landed first — manifest load must pick the selection up.
    app.selection = { kind: "module", configId: "nixos/test", moduleId: "self:modules/a.nix" }

    await app.loadManifest()
    expect(app.manifestError).toBe(null)
    expect(app.manifest?.flake.ref).toBe("/etc/test")
    expect(app.flakeIndexes).not.toBe(null)

    await Bun.sleep(0) // followed config load settles
    expect(loadedConfig(app.configs["nixos/test"])?.data.id).toBe("nixos/test")
    expect(app.fileExpanded.has("fdir:self/modules")).toBe(true)
  })

  test("schema drift surfaces a re-extract message", async () => {
    injectData("manifest.json", { ...fixtureManifest(), version: 999 })
    await app.loadManifest()
    expect(app.manifest).toBe(null)
    expect(app.manifestError).toContain("incompatible extractor")
    expect(app.manifestError).toContain(`v${SCHEMA_VERSION}`)
  })
})

describe("loadConfig", () => {
  beforeEach(() => {
    const m = fixtureManifest()
    app.manifest = m
    app.flakeIndexes = buildFlakeIndexes(m)
  })

  test("unknown config ids are ignored", async () => {
    await app.loadConfig("nixos/nope")
    expect(app.configs["nixos/nope"]).toBeUndefined()
  })

  test("a bad blob lands in an error slot; retryConfig recovers", async () => {
    injectData("config/nixos.test.json", { ...fixtureConfig(), version: 999 })
    await app.loadConfig("nixos/test")
    const slot = app.configs["nixos/test"]
    expect(slot && typeof slot === "object" && "error" in slot ? slot.error : "").toContain(
      "incompatible extractor",
    )

    // Fix the data, then retry: the error slot is evicted and reloaded.
    injected.get("config/nixos.test.json")!.textContent = JSON.stringify(fixtureConfig())
    app.retryConfig("nixos/test")
    await Bun.sleep(0)
    expect(loadedConfig(app.configs["nixos/test"])?.data.options.length).toBe(3)
  })

  test("an already-populated slot is not reloaded", async () => {
    app.configs = { "nixos/test": "loading" }
    await app.loadConfig("nixos/test")
    expect(app.configs["nixos/test"]).toBe("loading")
  })
})

describe("loadFileContent", () => {
  const FILE_ID = "self:lib/c.nix"
  const STORE = "/nix/store/aaaa-source/lib/c.nix"
  const tagName = `file/${encodeURIComponent(FILE_ID)}?storePath=${encodeURIComponent(STORE)}`

  test("failure records an error slot; retryFileContent recovers", async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch
    try {
      await app.loadFileContent(FILE_ID, STORE)
      const slot = app.fileContents[FILE_ID]
      expect(slot && typeof slot === "object" && "error" in slot ? slot.error : "").toContain(
        "HTTP 500",
      )

      injectData(tagName, { text: "x = 1;", tokens: [] })
      app.retryFileContent(FILE_ID, STORE)
      await Bun.sleep(0)
      expect(app.fileContents[FILE_ID]).toMatchObject({ text: "x = 1;" })

      // Loaded content is never refetched.
      await app.loadFileContent(FILE_ID, STORE)
      expect(app.fileContents[FILE_ID]).toMatchObject({ text: "x = 1;" })
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

describe("select + URL hash", () => {
  test("selection writes the hash; a repeat select only replaces", () => {
    app.select({ kind: "input", name: "nixpkgs" })
    expect(window.location.hash).toBe("#/i/nixpkgs")

    app.setFilters({ q: "ssh", all: true })
    expect(window.location.hash).toBe("#/i/nixpkgs?q=ssh&all=1")

    app.select({ kind: "input", name: "nixpkgs" }) // same selection — replaceState path
    expect(window.location.hash).toBe("#/i/nixpkgs?q=ssh&all=1")

    app.setFilters({ q: "", all: false })
    expect(window.location.hash).toBe("#/i/nixpkgs")
  })

  test("initRouting applies the current hash and tracks hashchange", () => {
    window.location.hash = "#/i/sops-nix"
    app.initRouting()
    expect(app.selection).toEqual({ kind: "input", name: "sops-nix" })

    window.location.hash = "#/c/nixos%2Ftest?q=zz"
    window.dispatchEvent(new Event("hashchange"))
    expect(app.selection).toEqual({ kind: "config", configId: "nixos/test" })
    expect(app.q).toBe("zz")
  })
})

describe("openAbout", () => {
  test("degrades silently without data, loads once it exists", async () => {
    app.about = null
    app.aboutOpen = false
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch
    try {
      await app.openAbout()
      expect(app.aboutOpen).toBe(true)
      expect(app.about).toBe(null)

      injectData("about.json", { name: "Flake Explorer", deps: [] })
      await app.openAbout()
      expect(app.about).toMatchObject({ name: "Flake Explorer" })
    } finally {
      globalThis.fetch = origFetch
    }
  })
})
