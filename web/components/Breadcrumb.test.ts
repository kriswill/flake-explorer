// Breadcrumb component + crumbsForFile, the shared orientation strip.

import { beforeEach, describe, expect, test } from "bun:test"
import Breadcrumb from "../app/components/Breadcrumb.svelte"
import { type Crumb, crumbsForFile } from "../app/lib/indexes"
import { app } from "../app/lib/state.svelte"
import { fixtureManifest, SELF, SOPS } from "./fixtures/data"
import { withMount } from "./helpers"

const selfMeta = {
  id: "self:modules/sub/b.nix",
  relPath: "modules/sub/b.nix",
  origin: { kind: "self" } as const,
  storePath: `${SELF}/modules/sub/b.nix`,
}

describe("crumbsForFile", () => {
  test("self file with a config: config › dirs › filename", () => {
    expect(crumbsForFile(selfMeta, "nixos/test")).toEqual([
      { label: "nixos/test", sel: { kind: "config", configId: "nixos/test" } },
      { label: "modules/sub/" },
      { label: "b.nix" },
    ])
  })

  test("without a config the config crumb is dropped", () => {
    expect(crumbsForFile(selfMeta).map((c) => c.label)).toEqual(["modules/sub/", "b.nix"])
  })

  test("input files get a linked input crumb", () => {
    const crumbs = crumbsForFile({
      id: "input:sops-nix:modules/sops/default.nix",
      relPath: "modules/sops/default.nix",
      origin: { kind: "input", input: "sops-nix" },
      storePath: `${SOPS}/modules/sops/default.nix`,
    })
    expect(crumbs).toEqual([
      { label: "sops-nix", sel: { kind: "input", name: "sops-nix" } },
      { label: "modules/sops/" },
      { label: "default.nix" },
    ])
  })

  test("a root-level file has no directory crumb", () => {
    const crumbs = crumbsForFile({
      id: "self:flake.nix",
      relPath: "flake.nix",
      origin: { kind: "self" },
      storePath: `${SELF}/flake.nix`,
    })
    expect(crumbs.map((c) => c.label)).toEqual(["flake.nix"])
  })

  test("unattributed store groups render as plain text (no page to link)", () => {
    const crumbs = crumbsForFile({
      id: "unknown:xyz:lib/x.nix",
      relPath: "lib/x.nix",
      origin: { kind: "unknown", group: "source@abc1234" },
      storePath: "/nix/store/xyz/lib/x.nix",
    })
    expect(crumbs[0]).toEqual({ label: "source@abc1234" })
  })
})

describe("Breadcrumb component", () => {
  beforeEach(() => {
    const m = fixtureManifest()
    app.manifest = m
    app.configs = {}
    app.selection = null
  })

  test("renders separators, links selectable segments, leaves plain ones as text", () => {
    const segments: Crumb[] = [
      { label: "nixos/test", sel: { kind: "config", configId: "nixos/test" } },
      { label: "modules/" },
      { label: "a.nix" },
    ]
    withMount(Breadcrumb, { segments }, (host) => {
      expect(host.querySelectorAll(".sep").length).toBe(2)
      const buttons = [...host.querySelectorAll("button")]
      expect(buttons.map((b) => b.textContent)).toEqual(["nixos/test"])
      buttons[0]!.click()
      expect(app.selection).toEqual({ kind: "config", configId: "nixos/test" })
    })
  })
})
