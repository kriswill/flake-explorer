// Legend.svelte: the input chips shown in the flake-overview panel.

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import Legend from "../app/components/Legend.svelte"
import { resetSlotKeys } from "../app/lib/color"
import { app } from "../app/lib/state.svelte"
import { fixtureManifest } from "./fixtures/data"
import { withMount } from "./helpers"

beforeEach(() => {
  app.manifest = fixtureManifest()
})

afterEach(resetSlotKeys)

describe("Legend", () => {
  test("renders a chip per direct input, skipping transitive ones", () => {
    app.manifest = {
      ...fixtureManifest(),
      inputs: {
        nixpkgs: { name: "nixpkgs", nodeKey: "nixpkgs", type: "github" },
        "nixpkgs/nested": {
          name: "nixpkgs/nested",
          nodeKey: "nested",
          type: "github",
          transitive: true,
        },
      },
    }
    withMount(Legend, {}, (host) => {
      const chips = host.querySelectorAll(".chip")
      expect(chips.length).toBe(1)
      expect(chips[0]!.textContent?.trim()).toBe("nixpkgs")
    })
  })

  test("a web-linkable input renders an <a> chip pointing at its url", () => {
    app.manifest = {
      ...fixtureManifest(),
      inputs: {
        nixpkgs: {
          name: "nixpkgs",
          nodeKey: "nixpkgs",
          type: "github",
          url: "https://github.com/NixOS/nixpkgs",
        },
      },
    }
    withMount(Legend, {}, (host) => {
      const link = host.querySelector<HTMLAnchorElement>("a.chip")
      expect(link?.href).toBe("https://github.com/NixOS/nixpkgs")
      expect(link?.target).toBe("_blank")
      expect(link?.title).toBe("https://github.com/NixOS/nixpkgs")
    })
  })

  test("a non-linkable input (local path, no url) renders a plain span chip", () => {
    app.manifest = {
      ...fixtureManifest(),
      inputs: { vendor: { name: "vendor", nodeKey: "vendor", type: "path" } },
    }
    withMount(Legend, {}, (host) => {
      expect(host.querySelector("a.chip")).toBeNull()
      const span = host.querySelector<HTMLSpanElement>("span.chip")
      expect(span?.textContent?.trim()).toBe("vendor")
      expect(span?.title).toBe("path") // falls back to input.type when no url
    })
  })

  test("no inputs renders an empty legend without error", () => {
    app.manifest = { ...fixtureManifest(), inputs: {} }
    withMount(Legend, {}, (host) => {
      expect(host.querySelectorAll(".chip").length).toBe(0)
    })
  })
})
