// OverlayDetail: overlay category listing and per-overlay pages built from
// Manifest.overlayDefs (the regex scan) + outputNames.overlays.

import { beforeEach, describe, expect, test } from "bun:test"
import OverlayDetail from "../app/components/OverlayDetail.svelte"
import { buildFlakeIndexes } from "../app/lib/indexes"
import { app } from "../app/lib/state.svelte"
import type { OutputNode } from "../src/schema"
import { fixtureManifest } from "./fixtures/data"
import { withMount } from "./helpers"

function seed() {
  const m = fixtureManifest()
  // lib/c.nix "defines" the default overlay; a.nix and sub/b.nix import it
  // (importEdges in the fixture) — the "imported by" context.
  m.overlayDefs = [{ name: "default", file: "self:lib/c.nix" }]
  m.outputNames = { overlays: ["default", "evaluated-only"] }
  app.manifest = m
  app.flakeIndexes = buildFlakeIndexes(m)
  app.selection = null
}

beforeEach(seed)

const mountAt = (path: string[], leaf: OutputNode | null, fn: (host: HTMLElement) => void) =>
  withMount(OverlayDetail, { path, leaf }, fn)

describe("category root", () => {
  test("lists the union of scanned and evaluated overlay names with links", () => {
    mountAt(["overlays"], null, (host) => {
      const links = [...host.querySelectorAll("button")].map((b) => b.textContent)
      expect(links).toEqual(["default", "evaluated-only"])
      // The scanned one shows its definition site inline.
      expect(host.textContent).toContain("lib/c.nix")
    })
  })

  test("clicking a name selects the overlay's output page", () => {
    app.manifest = { ...app.manifest!, configurations: [] } // keep select() inert
    mountAt(["overlays"], null, (host) => {
      host.querySelector("button")!.click()
      expect(app.selection).toEqual({ kind: "output", path: ["overlays", "default"] })
    })
  })

  test("no overlays anywhere: says so", () => {
    app.manifest = { ...app.manifest!, overlayDefs: [], outputNames: {} }
    mountAt(["overlays"], null, (host) => {
      expect(host.textContent).toContain("No overlays found")
    })
  })
})

describe("overlay page", () => {
  test("scanned overlay: defining file link, importers, and the leaf type", () => {
    const leaf: OutputNode = { kind: "leaf", type: "nixpkgs-overlay" }
    mountAt(["overlays", "default"], leaf, (host) => {
      expect(host.querySelector("h2")?.textContent).toBe("overlays.default")
      expect(host.textContent).toContain("nixpkgs-overlay")
      const links = [...host.querySelectorAll("button")].map((b) => b.textContent)
      expect(links).toContain("lib/c.nix")
      expect(links).toContain("modules/a.nix") // imports lib/c.nix
      expect(links).toContain("modules/sub/b.nix")
    })
  })

  test("defining file link fires a file selection", () => {
    mountAt(["overlays", "default"], null, (host) => {
      const link = [...host.querySelectorAll("button")].find((b) => b.textContent === "lib/c.nix")!
      link.click()
      expect(app.selection).toEqual({ kind: "file", fileId: "self:lib/c.nix" })
    })
  })

  test("unscanned overlay: honest fallback about the scanned forms", () => {
    mountAt(["overlays", "evaluated-only"], null, (host) => {
      expect(host.textContent).toContain("Definition site not found")
    })
  })
})
