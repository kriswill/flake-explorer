// TreeNode: the left module-tree row — label rendering (dir vs file
// disambiguation), badges, expansion, and module selection.

import { beforeEach, describe, expect, test } from "bun:test"
import { flushSync } from "svelte"
import TreeNode from "../app/components/TreeNode.svelte"
import { buildFlakeIndexes, type TreeNode as Node } from "../app/lib/indexes"
import { app } from "../app/lib/state.svelte"
import { fixtureManifest } from "./fixtures/data"
import { withMount } from "./helpers"

const CONFIG = "nixos/test"

const dir = (label: string, children: Node[] = []): Node => ({
  id: `dir:self/${label}`,
  label,
  children,
  customized: children.reduce((s, c) => s + c.customized, 0),
  declares: 0,
})

const file = (label: string, customized = 0): Node => ({
  id: `self:${label}`,
  label,
  fileId: `self:${label}`,
  children: [],
  customized,
  declares: 0,
})

beforeEach(() => {
  const m = fixtureManifest()
  app.manifest = m
  app.flakeIndexes = buildFlakeIndexes(m)
  app.configs = {}
  app.selection = null
  app.q = ""
  app.expanded.clear()
})

const mountNode = (node: Node, fn: (host: HTMLElement) => void) =>
  withMount(TreeNode, { node, configId: CONFIG, depth: 0 }, fn)

describe("labels", () => {
  test("directory nodes get a trailing slash, file nodes do not", () => {
    // The review's ambiguity case: a dir and a file that share a label sit
    // adjacent and behave differently on click (expand vs navigate).
    mountNode(dir("sops", [file("x.nix")]), (host) => {
      expect(host.querySelector(".label")?.textContent).toBe("sops/")
    })
    mountNode(file("sops.nix"), (host) => {
      expect(host.querySelector(".label")?.textContent).toBe("sops.nix")
    })
  })

  test("input group roots are not directories and keep a bare label", () => {
    const inputRoot: Node = {
      id: "input:sops-nix",
      label: "sops-nix",
      children: [file("modules/sops/default.nix")],
      customized: 0,
      declares: 1,
    }
    mountNode(inputRoot, (host) => {
      expect(host.querySelector(".label")?.textContent).toBe("sops-nix")
    })
  })
})

describe("badges and interaction", () => {
  test("a customized count renders as a badge; zero renders none", () => {
    mountNode(file("a.nix", 3), (host) => {
      expect(host.querySelector(".badge")?.textContent).toBe("3")
    })
    mountNode(file("b.nix", 0), (host) => {
      expect(host.querySelector(".badge")).toBeNull()
    })
  })

  test("clicking a file selects its module; clicking a dir toggles expansion", () => {
    mountNode(file("a.nix"), (host) => {
      host.querySelector("button")!.click()
      expect(app.selection).toEqual({
        kind: "module",
        configId: CONFIG,
        moduleId: "self:a.nix",
      })
    })

    const d = dir("modules", [file("a.nix")])
    mountNode(d, (host) => {
      host.querySelector("button")!.click()
      flushSync()
      expect(app.expanded.has(d.id)).toBe(true)
      host.querySelector("button")!.click()
      flushSync()
      expect(app.expanded.has(d.id)).toBe(false)
    })
  })

  test("the filter hides non-matching subtrees entirely", () => {
    app.q = "zzz"
    mountNode(file("a.nix"), (host) => {
      expect(host.querySelector(".row")).toBeNull()
    })
  })
})
