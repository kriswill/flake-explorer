// DiffView: the two-column configuration comparison — load affordances,
// the row table, filters, and navigation into option pages.

import { beforeEach, describe, expect, test } from "bun:test"
import { flushSync } from "svelte"
import DiffView from "../app/components/DiffView.svelte"
import { buildConfigIndexes, buildFlakeIndexes } from "../app/lib/indexes"
import type { ConfigData, OptionEntry } from "../app/lib/schema"
import { app } from "../app/lib/state.svelte"
import { fixtureManifest, opt, SELF } from "./fixtures/data"
import { withMount } from "./helpers"

const A = "nixos/test"
const B = "darwin/mini"

const set = (loc: string, over: Partial<OptionEntry> = {}) =>
  opt(loc.split("."), {
    customized: true,
    highestPrio: 100,
    definitions: [{ file: `${SELF}/modules/a.nix` }],
    ...over,
  })

function seed() {
  const m = fixtureManifest()
  m.configurations = [
    ...m.configurations,
    { id: B, kind: "darwin", name: "mini", dataFile: "config/darwin.mini.json", status: "pending" },
  ]
  app.manifest = m
  app.flakeIndexes = buildFlakeIndexes(m)
  app.configs = {}
  app.selection = null
  app.q = ""
  app.showAll = false
}

function load(id: string, options: OptionEntry[]) {
  const data: ConfigData = { version: 1, id, options, fileIndex: {} }
  app.configs = {
    ...app.configs,
    [id]: { data, indexes: buildConfigIndexes(app.manifest!, data, app.flakeIndexes!) },
  }
}

function loadBoth() {
  load(A, [
    set("shared.same", { value: 1 }),
    set("shared.differs", { value: "alpha" }),
    set("a.only", { value: true }),
  ])
  load(B, [set("shared.same", { value: 1 }), set("shared.differs", { value: "beta" })])
}

const mountDiff = (fn: (host: HTMLElement) => void) => withMount(DiffView, { a: A, b: B }, fn)

beforeEach(seed)

describe("load affordances", () => {
  test("unloaded sides offer load-in-place and no table renders", () => {
    mountDiff((host) => {
      const loaders = [...host.querySelectorAll("button")].filter(
        (b) => b.textContent === "load (may extract)",
      )
      expect(loaders.length).toBe(2)
      expect(host.querySelector("table")).toBeNull()
    })
  })

  test("an errored side surfaces its message with a retry", () => {
    load(A, [set("x")])
    app.configs = { ...app.configs, [B]: { error: "boom: eval failed" } }
    mountDiff((host) => {
      expect(host.textContent).toContain("boom: eval failed")
      expect(host.textContent).toContain("retry")
      expect(host.querySelector("table")).toBeNull()
    })
  })

  test("one side loaded is still not enough", () => {
    load(A, [set("x")])
    mountDiff((host) => {
      expect(host.querySelector("table")).toBeNull()
      expect(host.textContent).toContain("load (may extract)")
    })
  })
})

describe("the diff table", () => {
  test("summarizes counts and renders one row per differing option", () => {
    loadBoth()
    mountDiff((host) => {
      expect(host.textContent).toContain("1 only in A")
      expect(host.textContent).toContain("0 only in B")
      expect(host.textContent).toContain("1 differ")
      // Identical rows are hidden by default.
      const locs = [...host.querySelectorAll("tbody tr td:first-child")].map((td) => td.textContent)
      expect(locs).toEqual(["a.only", "shared.differs"])
    })
  })

  test("both sides' values render in their own columns", () => {
    loadBoth()
    mountDiff((host) => {
      const row = [...host.querySelectorAll("tbody tr")].find((r) =>
        r.textContent?.includes("shared.differs"),
      )!
      const cells = [...row.querySelectorAll("td")].map((td) => td.textContent)
      expect(cells[1]).toBe('"alpha"')
      expect(cells[2]).toBe('"beta"')
      expect(cells[3]).toBe("differs")
    })
  })

  test("an A-only row shows an em dash for the absent side", () => {
    loadBoth()
    mountDiff((host) => {
      const row = [...host.querySelectorAll("tbody tr")].find((r) =>
        r.textContent?.includes("a.only"),
      )!
      expect([...row.querySelectorAll("td")][2]!.textContent).toBe("—")
    })
  })

  test("the show-identical toggle reveals equal rows", () => {
    loadBoth()
    app.showAll = true
    mountDiff((host) => {
      const locs = [...host.querySelectorAll("tbody tr td:first-child")].map((td) => td.textContent)
      expect(locs).toContain("shared.same")
    })
  })

  test("the shared query filters rows by loc", () => {
    loadBoth()
    app.q = "a.only"
    mountDiff((host) => {
      const locs = [...host.querySelectorAll("tbody tr td:first-child")].map((td) => td.textContent)
      expect(locs).toEqual(["a.only"])
    })
  })

  test("a filter matching nothing says so instead of rendering an empty table", () => {
    loadBoth()
    app.q = "zzz-nope"
    mountDiff((host) => {
      expect(host.querySelector("table")).toBeNull()
      expect(host.textContent).toContain('No differing options match "zzz-nope"')
    })
  })

  test("identical configurations report that instead of an empty table", () => {
    load(A, [set("same", { value: 1 })])
    load(B, [set("same", { value: 1 })])
    mountDiff((host) => {
      expect(host.textContent).toContain("set the same options to the same values")
    })
  })
})

describe("navigation", () => {
  test("a loc links to that option's page in the side that has it", () => {
    loadBoth()
    mountDiff((host) => {
      const link = [...host.querySelectorAll<HTMLButtonElement>("tbody button")].find(
        (b) => b.textContent === "a.only",
      )!
      link.click()
      flushSync()
      expect(app.selection).toEqual({ kind: "option", configId: A, loc: ["a", "only"] })
    })
  })

  test("a B-only row links into config B", () => {
    load(A, [set("shared", { value: 1 })])
    load(B, [set("shared", { value: 1 }), set("b.only", { value: true })])
    mountDiff((host) => {
      const link = [...host.querySelectorAll<HTMLButtonElement>("tbody button")].find(
        (b) => b.textContent === "b.only",
      )!
      link.click()
      flushSync()
      expect(app.selection).toEqual({ kind: "option", configId: B, loc: ["b", "only"] })
    })
  })

  test("the load button asks state to load that side", () => {
    // No manifest entry can resolve here (configs are pending), so the call is
    // inert — what matters is that the click reaches loadConfig at all.
    mountDiff((host) => {
      const btn = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => b.textContent === "load (may extract)",
      )!
      btn.click()
      flushSync()
      expect(app.configs[A]).toBeDefined()
    })
  })

  test("retry on an errored side evicts the slot and retries", () => {
    load(A, [set("x")])
    app.configs = { ...app.configs, [B]: { error: "boom" } }
    mountDiff((host) => {
      const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => b.textContent === "retry",
      )!
      retry.click()
      flushSync()
      // retryConfig evicts the error slot and starts a fresh load, so the
      // stale message can't linger behind a load already under way.
      expect(app.configs[B]).toBe("loading")
    })
  })

  test("more rows than the cap renders the cap with an honest overflow note", () => {
    const many = Array.from({ length: 520 }, (_, i) =>
      set(`opt.n${String(i).padStart(4, "0")}`, { value: i }),
    )
    load(A, many)
    load(B, []) // every row is only-in-A
    mountDiff((host) => {
      expect(host.querySelectorAll("tbody tr").length).toBe(500)
      expect(host.textContent).toContain("Showing 500 of 520 rows")
    })
  })

  test("the header links to each configuration's page", () => {
    loadBoth()
    mountDiff((host) => {
      const link = [...host.querySelectorAll("button")].find((b) => b.textContent === B)!
      link.click()
      expect(app.selection).toEqual({ kind: "config", configId: B })
    })
  })
})
