// InputProvenance renders a locked input's identity card: linkable url/rev
// become anchors (webUrl/commitUrl), everything else stays plain text.

import { describe, expect, test } from "bun:test"
import InputProvenance from "../app/components/InputProvenance.svelte"
import type { InputInfo } from "../app/lib/schema"
import { withMount } from "./helpers"

const github: InputInfo = {
  name: "sops-nix",
  nodeKey: "sops-nix",
  type: "github",
  ref: "master",
  url: "https://github.com/Mic92/sops-nix",
  rev: "abcdef1234567890",
  narHash: "sha256-AAAA",
  lastModified: 1767225600, // 2026-01-01T00:00:00Z
}

describe("InputProvenance", () => {
  test("web-linkable input: url and rev render as commit-permalink anchors", () => {
    withMount(InputProvenance, { input: github }, (host) => {
      expect(host.textContent).toContain("input sops-nix")
      expect(host.textContent).toContain("github:master")
      expect(host.textContent).toContain("sha256-AAAA")
      expect(host.textContent).toContain("2026-01-01") // locked date from lastModified

      const hrefs = [...host.querySelectorAll("a")].map((a) => a.getAttribute("href"))
      expect(hrefs).toEqual([
        "https://github.com/Mic92/sops-nix",
        "https://github.com/Mic92/sops-nix/commit/abcdef1234567890",
      ])
    })
  })

  test("non-linkable input: plain text, follows shown, no locked date", () => {
    const path: InputInfo = {
      name: "vendor",
      nodeKey: "vendor",
      type: "path",
      url: "path:/some/dir",
      rev: "deadbeef",
      follows: "nixpkgs",
    }
    withMount(InputProvenance, { input: path }, (host) => {
      expect(host.querySelectorAll("a").length).toBe(0)
      expect(host.textContent).toContain("path:/some/dir")
      expect(host.textContent).toContain("deadbeef")
      expect(host.textContent).toContain("follows")
      expect(host.textContent).toContain("nixpkgs")
      expect(host.textContent).not.toContain("locked")
      expect(host.textContent).not.toContain("narHash")
    })
  })

  test("root-level aliases render as an 'alias → name' row", () => {
    const aliased: InputInfo = {
      name: "nixpkgs",
      nodeKey: "nixpkgs",
      type: "github",
      aliases: ["pinned", "stable"],
    }
    withMount(InputProvenance, { input: aliased }, (host) => {
      expect(host.textContent).toContain("aliases")
      expect(host.textContent).toContain("pinned, stable → nixpkgs")
    })
  })

  test("minimal input (follows-only node) renders just name and type", () => {
    const min: InputInfo = { name: "flake-utils", nodeKey: "flake-utils", type: "github" }
    withMount(InputProvenance, { input: min }, (host) => {
      expect(host.textContent).toContain("input flake-utils")
      expect(host.textContent).not.toContain("url")
      expect(host.textContent).not.toContain("rev")
    })
  })
})
