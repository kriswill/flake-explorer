// loadJson's two serving modes: embedded <script type="application/json">
// tag (single-file build) vs fetch from ./data/ (dev server).

import { afterEach, describe, expect, test } from "bun:test"
import { hasEmbedded, isStatic, loadJson } from "../app/lib/data"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
})

function injectTag(name: string, text: string) {
  const el = document.createElement("script")
  el.type = "application/json"
  el.id = `data:${name}`
  el.textContent = text
  document.head.appendChild(el)
  cleanup.push(() => el.remove())
}

function stubFetch(impl: typeof fetch) {
  const orig = globalThis.fetch
  globalThis.fetch = impl
  cleanup.push(() => {
    globalThis.fetch = orig
  })
}

describe("loadJson", () => {
  test("an embedded data tag wins without touching the network", async () => {
    injectTag("embedded.json", JSON.stringify({ a: 1 }))
    stubFetch((() => {
      throw new Error("fetch must not be called")
    }) as unknown as typeof fetch)
    expect(await loadJson<{ a: number }>("embedded.json")).toEqual({ a: 1 })
  })

  test("falls back to fetching ./data/<name> when no tag exists", async () => {
    stubFetch((async (url: unknown) => {
      expect(String(url)).toBe("data/remote.json")
      return new Response(JSON.stringify({ b: 2 }))
    }) as unknown as typeof fetch)
    expect(await loadJson<{ b: number }>("remote.json")).toEqual({ b: 2 })
  })

  test("an empty tag also falls through to fetch", async () => {
    injectTag("empty.json", "")
    stubFetch((async () => new Response('"ok"')) as unknown as typeof fetch)
    expect(await loadJson<string>("empty.json")).toBe("ok")
  })

  test("non-OK response throws with status and body text", async () => {
    stubFetch(
      (async () => new Response("gone missing", { status: 404 })) as unknown as typeof fetch,
    )
    await expect(loadJson("nope.json")).rejects.toThrow("loading nope.json: HTTP 404 gone missing")
  })
})

describe("hasEmbedded / isStatic", () => {
  test("hasEmbedded mirrors loadJson's non-empty-tag rule", () => {
    expect(hasEmbedded("x.json")).toBe(false)
    injectTag("x.json", '{"a":1}')
    expect(hasEmbedded("x.json")).toBe(true)
    injectTag("empty.json", "")
    expect(hasEmbedded("empty.json")).toBe(false)
  })

  test("isStatic keys off the embedded manifest tag", () => {
    expect(isStatic()).toBe(false)
    injectTag("manifest.json", "{}")
    expect(isStatic()).toBe(true)
  })
})
