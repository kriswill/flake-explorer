// Data-loading and routing paths of the app singleton: loadManifest/
// loadConfig/loadFileContent resolve through loadJson's embedded-tag mode
// (script tags injected into happy-dom), so no network is involved.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { resetSlotKeys } from "../app/lib/color"
import { buildFlakeIndexes } from "../app/lib/indexes"
import { SCHEMA_VERSION } from "../app/lib/schema"
import { app, loadedConfig, loadedPackage } from "../app/lib/state.svelte"
import { fixtureConfig, fixtureManifest, fixturePackageRefs } from "./fixtures/data"

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
  app.packages = {}
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

// loadManifest registers input names into color.ts's first-come slot
// registry — don't leak that into other test files' slot assertions.
afterAll(resetSlotKeys)

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

describe("loadPackage", () => {
  const PKG_ID = "packages/x86_64-linux/hello"
  const packageData = () => ({
    version: 1 as const,
    id: PKG_ID,
    path: ["packages", "x86_64-linux", "hello"],
    pname: "hello",
    builder: "unknown" as const,
    outputs: [],
    deps: { nativeBuildInputs: [], buildInputs: [], propagatedBuildInputs: [] },
    warnings: [],
  })

  beforeEach(() => {
    const m = fixtureManifest()
    app.manifest = m
    app.flakeIndexes = buildFlakeIndexes(m)
  })

  test("unknown package ids are ignored", async () => {
    await app.loadPackage("packages/x86_64-linux/nope")
    expect(app.packages["packages/x86_64-linux/nope"]).toBeUndefined()
  })

  test("loads a package blob; retryPackage recovers from a bad one", async () => {
    injectData(fixturePackageRefs()[0]!.dataFile, { ...packageData(), version: 999 })
    await app.loadPackage(PKG_ID)
    const slot = app.packages[PKG_ID]
    expect(slot && typeof slot === "object" && "error" in slot ? slot.error : "").toContain(
      "incompatible extractor",
    )

    injected.get(fixturePackageRefs()[0]!.dataFile)!.textContent = JSON.stringify(packageData())
    app.retryPackage(PKG_ID)
    await Bun.sleep(0)
    expect(loadedPackage(app.packages[PKG_ID])?.data.pname).toBe("hello")
  })

  test("an already-populated slot is not reloaded", async () => {
    app.packages = { [PKG_ID]: "loading" }
    await app.loadPackage(PKG_ID)
    expect(app.packages[PKG_ID]).toBe("loading")
  })

  test("#followSelection loads the package matching an output-tree selection", async () => {
    injectData(fixturePackageRefs()[0]!.dataFile, packageData())
    app.select({ kind: "output", path: ["packages", "x86_64-linux", "hello"] })
    await Bun.sleep(0)
    expect(loadedPackage(app.packages[PKG_ID])?.data.pname).toBe("hello")
  })

  test("#followSelection no-ops for an output path that isn't a package", async () => {
    app.select({ kind: "output", path: ["lib", "greeting"] })
    await Bun.sleep(0)
    expect(Object.keys(app.packages)).toEqual([])
  })

  test("#followSelection expands the left tree's ancestor chain for any output selection", () => {
    // Not package-specific: revealOutput expands the generic OutputBranch/
    // OutputsTree `out:<dot.joined.prefix>` keys for ANY output-tree leaf, a
    // deep link's equivalent of clicking down through each ancestor.
    app.select({ kind: "output", path: ["packages", "x86_64-linux", "hello"] })
    expect(app.expanded.has("out:packages")).toBe(true)
    expect(app.expanded.has("out:packages.x86_64-linux")).toBe(true)
    // The leaf itself never gets its own expand key (nothing to expand into).
    expect(app.expanded.has("out:packages.x86_64-linux.hello")).toBe(false)

    app.expanded.clear()
    app.select({ kind: "output", path: ["lib", "greeting"] })
    expect(app.expanded.has("out:lib")).toBe(true)

    app.expanded.clear()
    // formatter.<system> is depth 2 (no name level) — one ancestor to expand.
    app.select({ kind: "output", path: ["formatter", "x86_64-linux"] })
    expect(app.expanded.has("out:formatter")).toBe(true)
  })

  test("applyHash (a real deep link / back-forward) expands the tree the same way select() does", () => {
    app.applyHash("#/o/packages.x86_64-linux.hello")
    expect(app.selection).toEqual({ kind: "output", path: ["packages", "x86_64-linux", "hello"] })
    expect(app.expanded.has("out:packages")).toBe(true)
    expect(app.expanded.has("out:packages.x86_64-linux")).toBe(true)
  })
})

describe("left-tree orientation (config/module/option selections)", () => {
  async function seedLoaded() {
    const m = fixtureManifest()
    injectData("manifest.json", m)
    injectData("config/nixos.test.json", fixtureConfig())
    await app.loadManifest()
    await app.loadConfig("nixos/test")
  }

  test("a config selection opens its category and config node", () => {
    app.manifest = fixtureManifest()
    app.flakeIndexes = buildFlakeIndexes(app.manifest)
    app.select({ kind: "config", configId: "nixos/test" })
    expect(app.expanded.has("out:nixosConfigurations")).toBe(true)
    expect(app.expanded.has("cfg:nixos/test")).toBe(true)
  })

  test("a module deep link expands the module tree's dir chain down to the file", async () => {
    await seedLoaded()
    app.expanded.clear()
    app.applyHash("#/c/nixos%2Ftest/m/self%3Amodules%2Fsub%2Fb.nix")
    // Wait for the (already-resolved) loadConfig promise chain to settle.
    await Promise.resolve()
    expect(app.expanded.has("out:nixosConfigurations")).toBe(true)
    expect(app.expanded.has("cfg:nixos/test")).toBe(true)
    expect(app.expanded.has("dir:self/modules")).toBe(true)
    expect(app.expanded.has("dir:self/modules/sub")).toBe(true)
    // The right file tree is revealed too (pre-existing behavior).
    expect(app.fileExpanded.has("fdir:self/modules")).toBe(true)
  })

  test("an option deep link expands to its declaring module in the left tree", async () => {
    await seedLoaded()
    app.expanded.clear()
    // services.x.enable is declared by modules/sub/b.nix in the fixture.
    app.applyHash("#/c/nixos%2Ftest/opt/services.x.enable")
    await Promise.resolve()
    await Promise.resolve()
    expect(app.expanded.has("cfg:nixos/test")).toBe(true)
    expect(app.expanded.has("dir:self/modules/sub")).toBe(true)
  })

  test("revealModule is inert (not throwing) for an unloaded config", () => {
    app.manifest = fixtureManifest()
    app.flakeIndexes = buildFlakeIndexes(app.manifest)
    app.revealModule("nixos/test", "self:modules/a.nix")
    // Config chain still opens; the dir chain simply isn't known yet.
    expect(app.expanded.has("cfg:nixos/test")).toBe(true)
    expect(app.expanded.has("dir:self/modules")).toBe(false)
  })
})

describe("line anchor (?L=)", () => {
  test("selectFileAt sets the line; a later selection change clears it", () => {
    app.manifest = fixtureManifest()
    app.flakeIndexes = buildFlakeIndexes(app.manifest)
    app.selectFileAt("self:lib/c.nix", 42)
    expect(app.selection).toEqual({ kind: "file", fileId: "self:lib/c.nix" })
    expect(app.line).toBe(42)

    app.select({ kind: "file", fileId: "self:modules/a.nix" })
    expect(app.line).toBeNull()
  })

  test("a re-select of the SAME file keeps the line (filter-only change)", () => {
    app.manifest = fixtureManifest()
    app.flakeIndexes = buildFlakeIndexes(app.manifest)
    app.selectFileAt("self:lib/c.nix", 7)
    app.select({ kind: "file", fileId: "self:lib/c.nix" })
    expect(app.line).toBe(7)
  })

  test("applyHash restores the line from ?L=", () => {
    app.manifest = fixtureManifest()
    app.flakeIndexes = buildFlakeIndexes(app.manifest)
    app.applyHash("#/f/self:lib%2Fc.nix?L=108")
    expect(app.line).toBe(108)
    app.applyHash("#/f/self:lib%2Fc.nix")
    expect(app.line).toBeNull()
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

// A static export embeds manifest.json — its presence tells the app there is
// no server behind the page: missing documents become permanent "not
// included" slots (no retry button) instead of doomed fetches.
describe("static export mode", () => {
  let fetchCalls = 0
  const origFetch = globalThis.fetch

  beforeEach(() => {
    fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls++
      return new Response("nope", { status: 500 })
    }) as unknown as typeof fetch
    const m = fixtureManifest()
    injectData("manifest.json", m)
    app.manifest = m
    app.flakeIndexes = buildFlakeIndexes(m)
  })

  afterEach(() => {
    globalThis.fetch = origFetch
  })

  test("a config without an embedded blob is permanently not-included", async () => {
    await app.loadConfig("nixos/test")
    expect(app.configs["nixos/test"]).toEqual({
      error: "configuration not included in this export",
      permanent: true,
    })
    expect(fetchCalls).toBe(0)
  })

  test("a config that failed during export surfaces its extraction error", async () => {
    const m = fixtureManifest()
    m.configurations[0]!.status = "error"
    m.configurations[0]!.error = "boom"
    app.manifest = m
    await app.loadConfig("nixos/test")
    expect(app.configs["nixos/test"]).toEqual({
      error: "extraction failed during export: boom",
      permanent: true,
    })
    expect(fetchCalls).toBe(0)
  })

  test("an embedded config still loads normally", async () => {
    injectData("config/nixos.test.json", fixtureConfig())
    await app.loadConfig("nixos/test")
    expect(loadedConfig(app.configs["nixos/test"])?.data.id).toBe("nixos/test")
    expect(fetchCalls).toBe(0)
  })

  test("a package without an embedded blob is permanently not-included", async () => {
    const pkgId = fixturePackageRefs()[0]!.id
    await app.loadPackage(pkgId)
    expect(app.packages[pkgId]).toEqual({
      error: "package not included in this export",
      permanent: true,
    })
    expect(fetchCalls).toBe(0)
  })

  test("file content resolves from the id-keyed embed; absent files are permanent", async () => {
    injectData(`file/${encodeURIComponent("self:lib/c.nix")}`, { text: "x = 1;", tokens: [] })
    await app.loadFileContent("self:lib/c.nix", "/nix/store/aaaa-source/lib/c.nix")
    expect(app.fileContents["self:lib/c.nix"]).toMatchObject({ text: "x = 1;" })

    await app.loadFileContent("self:other.nix", "/nix/store/aaaa-source/other.nix")
    expect(app.fileContents["self:other.nix"]).toEqual({
      error: "source not included in this export (re-export with --sources all)",
      permanent: true,
    })
    expect(fetchCalls).toBe(0)
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
