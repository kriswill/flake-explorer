// FileList: the right-pane file tree — group assembly and the
// contributing-files-only toggle.

import { beforeEach, describe, expect, test } from "bun:test"
import { flushSync } from "svelte"
import FileList from "../app/components/FileList.svelte"
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
  app.contribOnly = false
  app.fileExpanded.clear()
}

function loadConfig() {
  const config = fixtureConfig()
  app.configs = {
    "nixos/test": {
      data: config,
      indexes: buildConfigIndexes(app.manifest!, config, app.flakeIndexes!),
    },
  }
}

/** Group headers, in render order. */
const groupLabels = (host: HTMLElement) =>
  [...host.querySelectorAll(".glabel")].map((e) => e.textContent)

/** The self group's file count badge. */
const selfCount = (host: HTMLElement) => host.querySelector(".count")?.textContent

beforeEach(seed)

describe("groups", () => {
  test("self files always show; input groups appear once a config is loaded", () => {
    withMount(FileList, {}, (host) => {
      expect(groupLabels(host)).toEqual(["/etc/test"])
    })
    loadConfig()
    withMount(FileList, {}, (host) => {
      // sops-nix contributes modules/sops/default.nix to the fixture config.
      expect(groupLabels(host)).toEqual(["/etc/test", "sops-nix"])
    })
  })
})

describe("contributing-files toggle", () => {
  test("is disabled with an explanatory hint until a config is loaded", () => {
    withMount(FileList, {}, (host) => {
      const box = host.querySelector<HTMLInputElement>(".contrib input")!
      expect(box.disabled).toBe(true)
      expect(host.textContent).toContain("load a configuration first")
    })
  })

  test("enabled once a config is loaded, and trims the self group to contributors", () => {
    loadConfig()
    withMount(FileList, {}, (host) => {
      const box = host.querySelector<HTMLInputElement>(".contrib input")!
      expect(box.disabled).toBe(false)
      // The fixture manifest has 3 self files; the config only uses 2 of them
      // (modules/a.nix + modules/sub/b.nix — lib/c.nix contributes nothing).
      expect(selfCount(host)).toBe("3")

      box.checked = true
      box.dispatchEvent(new Event("change", { bubbles: true }))
      flushSync()
      expect(app.contribOnly).toBe(true)
      expect(selfCount(host)).toBe("2")
    })
  })

  test("with the toggle on but no config loaded, nothing is hidden", () => {
    app.contribOnly = true
    withMount(FileList, {}, (host) => {
      // Hiding every file because no config is loaded would read as a bug.
      expect(selfCount(host)).toBe("3")
    })
  })
})
