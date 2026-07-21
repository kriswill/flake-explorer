// InputDetail.svelte: the "inputs.<name>" panel showing an input's own
// flake.nix. Exercises the $effect-driven loadFileContent the same way
// state-loading.test.ts does for app.loadFileContent directly — fetch is
// mocked (or an embed pre-injected) BEFORE mount, since the effect fires
// immediately and a real fetch would otherwise race any assertion made
// after the fact (see the failed first draft of this file: a stray real
// fetch resolved asynchronously and clobbered a manually-set error state).

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { flushSync, mount, unmount } from "svelte"
import InputDetail from "../app/components/InputDetail.svelte"
import { buildConfigIndexes, buildFlakeIndexes } from "../app/lib/indexes"
import { app } from "../app/lib/state.svelte"
import { makeFileId } from "../src/schema"
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

beforeEach(() => {
  app.manifest = fixtureManifest()
  app.flakeIndexes = buildFlakeIndexes(app.manifest)
  app.fileContents = {}
  app.configs = {}
  app.selection = null
})

/** Pre-seed the input's own flake.nix so the mount-time $effect never fetches. */
function seedSource(input: string) {
  const fileId = makeFileId({ kind: "input", input }, "flake.nix")
  app.fileContents = { ...app.fileContents, [fileId]: { text: "{ }", tokens: [] } }
}

afterEach(() => {
  for (const el of injected.splice(0)) el.remove()
})

describe("InputDetail", () => {
  test("unknown input name", () => {
    withMount(InputDetail, { name: "nope" }, (host) => {
      expect(host.textContent).toContain('No input named "nope"')
    })
  })

  test("known input without a storePath: no fetch attempted, 'source not available'", () => {
    app.manifest = {
      ...fixtureManifest(),
      inputs: { vendor: { name: "vendor", nodeKey: "vendor", type: "path" } },
    }
    withMount(InputDetail, { name: "vendor" }, (host) => {
      expect(host.querySelector("h2")?.textContent).toBe("inputs.vendor")
      expect(host.textContent).toContain("Source not available")
      expect(host.querySelector(".path")?.textContent).toBe("")
    })
  })

  test("transitive input without source: depth-honest message", () => {
    app.manifest = {
      ...fixtureManifest(),
      inputs: {
        "nixpkgs/systems": {
          name: "nixpkgs/systems",
          nodeKey: "systems",
          type: "github",
          transitive: true,
        },
      },
    }
    withMount(InputDetail, { name: "nixpkgs/systems" }, (host) => {
      expect(host.textContent).toContain(
        "Source not available for transitive inputs beyond the fetched depth.",
      )
    })
  })

  test("known input with a storePath: resolves from an embedded blob (no network)", async () => {
    const storePath = "/nix/store/aaaa-vendor"
    app.manifest = {
      ...fixtureManifest(),
      inputs: { vendor: { name: "vendor", nodeKey: "vendor", type: "path", storePath } },
    }
    const fileId = makeFileId({ kind: "input", input: "vendor" }, "flake.nix")
    // Pre-injected so the mount-time $effect resolves from it directly.
    injectData(`file/${encodeURIComponent(fileId)}`, {
      text: 'description = "vendor";',
      tokens: [],
    })

    const host = document.createElement("div")
    document.body.appendChild(host)
    const instance = mount(InputDetail, { target: host, props: { name: "vendor" } })
    try {
      // loadJson is async even resolving from an embedded tag (one microtask
      // hop through `async function`) — flushSync alone won't wait for it.
      await Bun.sleep(0)
      flushSync()
      expect(host.querySelector(".path")?.textContent).toBe(`${storePath}/flake.nix`)
      expect(host.querySelector(".src")?.textContent).toContain('description = "vendor";')
    } finally {
      void unmount(instance)
      host.remove()
    }
  })

  test("referenced-by lists scanning hits as file links", () => {
    seedSource("sops-nix")
    withMount(InputDetail, { name: "sops-nix" }, (host) => {
      expect(host.textContent).toContain("Referenced by")
      const link = buttonsWithText(host, "modules/a.nix")[0]!
      link.click()
      expect(app.selection).toEqual({ kind: "file", fileId: "self:modules/a.nix" })
    })
  })

  test("no scanning hits: honest empty state", () => {
    seedSource("nixpkgs")
    withMount(InputDetail, { name: "nixpkgs" }, (host) => {
      expect(host.textContent).toContain("No source references to inputs.nixpkgs")
    })
  })

  test("modules contributed: unloaded config offers a load button, loaded one lists modules", () => {
    seedSource("sops-nix")
    withMount(InputDetail, { name: "sops-nix" }, (host) => {
      expect(host.textContent).toContain("load to see contributed modules")
    })

    const config = fixtureConfig()
    app.configs = {
      "nixos/test": {
        data: config,
        indexes: buildConfigIndexes(app.manifest!, config, app.flakeIndexes!),
      },
    }
    withMount(InputDetail, { name: "sops-nix" }, (host) => {
      expect(host.textContent).toContain("1 modules")
      const link = buttonsWithText(host, "modules/sops/default.nix")[0]!
      link.click()
      expect(app.selection).toEqual({
        kind: "module",
        configId: "nixos/test",
        moduleId: "input:sops-nix:modules/sops/default.nix",
      })
    })
  })

  test("modules contributed: loading and errored configs don't show a dead load button", async () => {
    seedSource("sops-nix")
    app.configs = { "nixos/test": "loading" }
    withMount(InputDetail, { name: "sops-nix" }, (host) => {
      expect(host.textContent).not.toContain("load to see contributed modules")
      expect(host.textContent).toContain("loading modules…")
    })

    // Failed load: error text + a retry that actually recovers (loadConfig
    // no-ops on an occupied slot, so the plain load button never could).
    app.configs = { "nixos/test": { error: "extraction failed: boom" } }
    injectData("config/nixos.test.json", fixtureConfig())
    const host = document.createElement("div")
    document.body.appendChild(host)
    const instance = mount(InputDetail, { target: host, props: { name: "sops-nix" } })
    try {
      expect(host.textContent).not.toContain("load to see contributed modules")
      expect(host.textContent).toContain("extraction failed: boom")
      buttonsWithText(host, "retry")[0]!.click()
      await Bun.sleep(0)
      flushSync()
      expect(host.textContent).toContain("1 modules")
    } finally {
      void unmount(instance)
      host.remove()
    }
  })

  test("modules contributed: a permanent error (static export) hides retry", () => {
    seedSource("sops-nix")
    app.configs = {
      "nixos/test": { error: "configuration not included in this export", permanent: true },
    }
    withMount(InputDetail, { name: "sops-nix" }, (host) => {
      expect(host.textContent).not.toContain("load to see contributed modules")
      expect(host.textContent).toContain("configuration not included in this export")
      expect(buttonsWithText(host, "retry").length).toBe(0)
    })
  })

  test("grafted outputs link back to the output node", () => {
    app.manifest = {
      ...app.manifest!,
      grafts: [{ output: "lib", input: "nixpkgs", added: ["mine"], inherited: 12 }],
    }
    seedSource("nixpkgs")
    withMount(InputDetail, { name: "nixpkgs" }, (host) => {
      expect(host.textContent).toContain("Outputs built from it")
      expect(host.textContent).toContain("1 added, 12 inherited")
      buttonsWithText(host, "lib")[0]!.click()
      expect(app.selection).toEqual({ kind: "output", path: ["lib"] })
    })
  })

  test("its inputs: transitive entries link to input pages, follows edges to their target", () => {
    app.manifest = {
      ...app.manifest!,
      inputs: {
        ...app.manifest!.inputs,
        "sops-nix/stable": {
          name: "sops-nix/stable",
          nodeKey: "st",
          transitive: true,
          type: "github",
          rev: "abcdef1234567",
        },
      },
    }
    seedSource("sops-nix")
    withMount(InputDetail, { name: "sops-nix" }, (host) => {
      expect(host.textContent).toContain("Its inputs")
      // Transitive entry links to its own input page.
      buttonsWithText(host, "stable")[0]!.click()
      expect(app.selection).toEqual({ kind: "input", name: "sops-nix/stable" })
      // Follows edge (fixture: sops-nix/nixpkgs → nixpkgs) links to the target.
      expect(host.textContent).toContain("→ follows")
      buttonsWithText(host, "nixpkgs")[0]!.click()
      expect(app.selection).toEqual({ kind: "input", name: "nixpkgs" })
    })
  })

  test("a transitive input's page hides the referenced-by section", () => {
    app.manifest = {
      ...app.manifest!,
      inputs: {
        ...app.manifest!.inputs,
        "sops-nix/stable": {
          name: "sops-nix/stable",
          nodeKey: "st",
          transitive: true,
          type: "github",
        },
      },
    }
    seedSource("sops-nix/stable")
    withMount(InputDetail, { name: "sops-nix/stable" }, (host) => {
      expect(host.textContent).not.toContain("Referenced by")
    })
  })

  test("a failed load shows the error (first line only) with a retry that recovers", async () => {
    const storePath = "/nix/store/aaaa-vendor"
    app.manifest = {
      ...fixtureManifest(),
      inputs: { vendor: { name: "vendor", nodeKey: "vendor", type: "path", storePath } },
    }
    const fileId = makeFileId({ kind: "input", input: "vendor" }, "flake.nix")

    const origFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch

    const host = document.createElement("div")
    document.body.appendChild(host)
    const instance = mount(InputDetail, { target: host, props: { name: "vendor" } })
    try {
      await Bun.sleep(0)
      flushSync()
      expect(host.textContent).toContain("HTTP 500")

      injectData(`file/${encodeURIComponent(fileId)}`, {
        text: 'description = "vendor";',
        tokens: [],
      })
      buttonsWithText(host, "retry")[0]!.click()
      await Bun.sleep(0)
      flushSync()
      expect(host.querySelector(".src")?.textContent).toContain('description = "vendor";')
    } finally {
      globalThis.fetch = origFetch
      void unmount(instance)
      host.remove()
    }
  })
})
