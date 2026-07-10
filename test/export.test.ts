// Real-nix end-to-end test of the single-file export: extractToDir +
// exportHtml against test/fixtures/mini-flake, then pull the embedded data
// tags back out of the HTML and check they carry what the static UI needs.
// Needs `nix` on PATH — skipped otherwise (see mini-flake.test.ts).

import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { exportHtml } from "../src/export"
import { extractToDir } from "../src/extract/drive"
import type { ConfigData, FileSource, Manifest } from "../src/schema"

const FIXTURE = join(import.meta.dir, "fixtures/mini-flake")
const hasNix = !!Bun.which("nix")

if (!hasNix && process.env.FLAKE_EXPLORER_REQUIRE_NIX) {
  throw new Error(
    "FLAKE_EXPLORER_REQUIRE_NIX is set but `nix` is not on PATH — the integration suite would silently skip",
  )
}

/** Parse an embedded data tag out of the page. [^<]* only matches because
 *  every "<" in a tag body is escaped — a raw one fails the test by design. */
function embedded<T>(html: string, name: string): T | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const m = html.match(
    new RegExp(`<script type="application/json" id="data:${escaped}">([^<]*)</script>`),
  )
  return m ? (JSON.parse(m[1]!) as T) : null
}

describe.skipIf(!hasNix)("export (real nix)", () => {
  test("--all --sources all: manifest, config blob, and file sources embed", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "mini-export-"))
    try {
      const flags = { out: outDir, configs: "all" as const, allSystems: false, timeout: 60 }
      const { manifest, wanted } = await extractToDir(FIXTURE, flags)
      const htmlPath = join(outDir, "flake.html")
      const summary = await exportHtml(FIXTURE, manifest, {
        outDir,
        htmlPath,
        sources: "all",
        timeoutMs: 60_000,
        wanted,
      })
      const html = await Bun.file(htmlPath).text()

      const m = embedded<Manifest>(html, "manifest.json")
      expect(m?.configurations[0]).toMatchObject({ id: "nixos/mini", status: "ok" })

      const cfg = embedded<ConfigData>(html, "config/nixos.mini.json")
      expect(cfg?.id).toBe("nixos/mini")
      expect(cfg?.options.length).toBeGreaterThan(0)

      const flakeSrc = embedded<FileSource>(html, `file/${encodeURIComponent("self:flake.nix")}`)
      expect(flakeSrc?.text).toContain("flake-explorer test fixture")
      expect(flakeSrc?.tokens.length).toBeGreaterThan(0)

      // The input's own flake.nix (what InputDetail shows) is always embedded.
      expect(
        embedded<FileSource>(html, `file/${encodeURIComponent("input:vendor:flake.nix")}`),
      ).not.toBeNull()

      expect(summary.configs).toEqual(["nixos/mini"])
      expect(summary.files).toContain("self:flake.nix")
      expect(summary.htmlBytes).toBe(Buffer.byteLength(html))
    } finally {
      await rm(outDir, { recursive: true, force: true })
    }
  })

  test("default export (no --configs): ref stays pending, self sources still embed", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "mini-export-"))
    try {
      const flags = { out: outDir, configs: null, allSystems: false, timeout: 60 }
      const { manifest, wanted } = await extractToDir(FIXTURE, flags)
      const htmlPath = join(outDir, "flake.html")
      const summary = await exportHtml(FIXTURE, manifest, {
        outDir,
        htmlPath,
        sources: "self",
        timeoutMs: 60_000,
        wanted,
      })
      const html = await Bun.file(htmlPath).text()

      const m = embedded<Manifest>(html, "manifest.json")
      expect(m?.configurations[0]?.status).toBe("pending")
      expect(embedded(html, "config/nixos.mini.json")).toBeNull()
      expect(embedded(html, `file/${encodeURIComponent("self:flake.nix")}`)).not.toBeNull()
      expect(summary.configs).toEqual([])
    } finally {
      await rm(outDir, { recursive: true, force: true })
    }
  })
})
