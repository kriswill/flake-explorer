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
import { app } from "../app/lib/state.svelte"
import { makeFileId } from "../src/schema"
import { fixtureManifest } from "./fixtures/data"
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
  app.fileContents = {}
})

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
