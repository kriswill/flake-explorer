// SearchBox: the header search input plus its unified results dropdown.
// Typing still live-filters the trees (app.q), and additionally opens a
// categorized dropdown over options/packages/files/inputs.

import { beforeEach, describe, expect, test } from "bun:test"
import { flushSync, mount, unmount } from "svelte"
import SearchBox from "../app/components/SearchBox.svelte"
import { buildConfigIndexes, buildFlakeIndexes } from "../app/lib/indexes"
import { app } from "../app/lib/state.svelte"
import { fixtureConfig, fixtureManifest } from "./fixtures/data"
import { withMount } from "./helpers"

function seed() {
  const m = fixtureManifest()
  app.manifest = m
  app.flakeIndexes = buildFlakeIndexes(m)
  app.configs = {}
  app.selection = null
  app.q = ""
}

function loadTestConfig() {
  const config = fixtureConfig()
  app.configs = {
    "nixos/test": {
      data: config,
      indexes: buildConfigIndexes(app.manifest!, config, app.flakeIndexes!),
    },
  }
}

function type(host: HTMLElement, text: string) {
  const input = host.querySelector("input")!
  input.value = text
  input.dispatchEvent(new Event("input", { bubbles: true }))
  flushSync()
}

const keydown = (host: HTMLElement, key: string) => {
  host.querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }))
  flushSync()
}

beforeEach(seed)

describe("SearchBox", () => {
  test("typing filters the trees (app.q) AND opens the dropdown", () => {
    loadTestConfig()
    withMount(SearchBox, {}, (host) => {
      type(host, "enable")
      expect(app.q).toBe("enable")
      expect(host.querySelector(".results")).not.toBeNull()
      expect(host.textContent).toContain("Options")
      expect(host.textContent).toContain("services.x.enable")
      expect(host.textContent).toContain("set by a.nix")
    })
  })

  test("clicking an option hit navigates to its option page", () => {
    loadTestConfig()
    withMount(SearchBox, {}, (host) => {
      type(host, "enable")
      const hit = [...host.querySelectorAll<HTMLButtonElement>(".hit")].find((b) =>
        b.textContent?.includes("services.x.enable"),
      )!
      hit.click()
      flushSync()
      expect(app.selection).toEqual({
        kind: "option",
        configId: "nixos/test",
        loc: ["services", "x", "enable"],
      })
      expect(host.querySelector(".results")).toBeNull() // closed after pick
    })
  })

  test("arrow keys move the active row, Enter picks it", () => {
    loadTestConfig()
    withMount(SearchBox, {}, (host) => {
      type(host, "services.x")
      const labels = [...host.querySelectorAll(".hit .label")].map((el) => el.textContent)
      expect(labels.length).toBeGreaterThan(1)
      keydown(host, "ArrowDown")
      keydown(host, "Enter")
      // Second row picked (index started at 0).
      expect(app.selection).toMatchObject({ kind: "option", loc: ["services", "x", "port"] })
    })
  })

  test("Escape closes the dropdown but keeps the filter text", () => {
    loadTestConfig()
    withMount(SearchBox, {}, (host) => {
      type(host, "enable")
      keydown(host, "Escape")
      expect(host.querySelector(".results")).toBeNull()
      expect(app.q).toBe("enable")
    })
  })

  test("packages and inputs surface without any loaded configuration", () => {
    withMount(SearchBox, {}, (host) => {
      type(host, "hello")
      expect(host.textContent).toContain("Packages")
      expect(host.textContent).toContain("packages.x86_64-linux.hello")
      type(host, "sops")
      expect(host.textContent).toContain("Inputs")
    })
  })

  test("unloaded configurations get a load-on-demand footer row", () => {
    withMount(SearchBox, {}, (host) => {
      type(host, "enable")
      expect(host.textContent).toContain("search options in nixos/test (loads on demand)")
    })
    app.configs = { "nixos/test": "loading" }
    withMount(SearchBox, {}, (host) => {
      type(host, "enable")
      expect(host.textContent).toContain("loading nixos/test…")
    })
  })

  test("no matches: honest empty state mentioning the unloaded corpus", () => {
    withMount(SearchBox, {}, (host) => {
      type(host, "zzzz-no-such-thing")
      expect(host.textContent).toContain("no configuration loaded yet")
    })
  })

  test("focusing with an existing query reopens the dropdown", () => {
    loadTestConfig()
    app.q = "enable"
    withMount(SearchBox, {}, (host) => {
      expect(host.querySelector(".results")).toBeNull()
      host.querySelector("input")!.dispatchEvent(new FocusEvent("focus"))
      flushSync()
      expect(host.querySelector(".results")).not.toBeNull()
    })
  })

  test("focus leaving the widget closes the dropdown", () => {
    loadTestConfig()
    withMount(SearchBox, {}, (host) => {
      type(host, "enable")
      expect(host.querySelector(".results")).not.toBeNull()
      const outside = document.createElement("button")
      document.body.appendChild(outside)
      try {
        host
          .querySelector(".wrap")!
          .dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: outside }))
        flushSync()
        expect(host.querySelector(".results")).toBeNull()
      } finally {
        outside.remove()
      }
    })
  })

  test("ArrowUp from the top wraps to the last hit", () => {
    loadTestConfig()
    withMount(SearchBox, {}, (host) => {
      type(host, "services.x")
      const count = host.querySelectorAll(".hit").length
      expect(count).toBeGreaterThan(1)
      keydown(host, "ArrowUp")
      const rows = [...host.querySelectorAll(".hit")]
      expect(rows[rows.length - 1]!.classList.contains("active")).toBe(true)
    })
  })

  test("static export: first search focus auto-loads embedded config blobs", async () => {
    // An embedded manifest tag is THE static-mode signal (isStatic), and the
    // config blob resolves from its own embedded tag — no fetch, no server.
    const inject = (name: string, value: unknown) => {
      const el = document.createElement("script")
      el.type = "application/json"
      el.id = `data:${name}`
      el.textContent = JSON.stringify(value)
      document.head.appendChild(el)
      return el
    }
    const tags = [
      inject("manifest.json", app.manifest),
      inject("config/nixos.test.json", fixtureConfig()),
    ]
    const host = document.createElement("div")
    document.body.appendChild(host)
    const instance = mount(SearchBox, { target: host, props: {} })
    try {
      flushSync()
      host.querySelector("input")!.dispatchEvent(new FocusEvent("focus"))
      await Bun.sleep(0) // loadJson resolves embedded tags asynchronously
      flushSync()
      type(host, "enable")
      expect(host.textContent).toContain("services.x.enable")
      expect(host.textContent).not.toContain("loads on demand")
    } finally {
      void unmount(instance)
      host.remove()
      for (const t of tags) t.remove()
    }
  })
})
