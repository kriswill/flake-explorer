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
import type { ConfigData, FileSource, Manifest, PackageData } from "../src/schema"
import { fixtureConfig, fixtureManifest, fixturePackageRefs } from "./fixtures/data"

const FIXTURE = join(import.meta.dir, "fixtures/mini-flake")
const BROKEN = join(import.meta.dir, "fixtures/broken-flake")
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
  test("--all --sources all: manifest, config blob, package blob, and file sources embed", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "mini-export-"))
    try {
      const flags = {
        out: outDir,
        configs: "all" as const,
        packages: "all" as const,
        allSystems: false,
        timeout: 60,
      }
      const { manifest, wanted, wantedPackages } = await extractToDir(FIXTURE, flags)
      const htmlPath = join(outDir, "flake.html")
      const summary = await exportHtml(FIXTURE, manifest, {
        outDir,
        htmlPath,
        sources: "all",
        timeoutMs: 60_000,
        wanted,
        wantedPackages,
      })
      const html = await Bun.file(htmlPath).text()

      const m = embedded<Manifest>(html, "manifest.json")
      expect(m?.configurations[0]).toMatchObject({ id: "nixos/mini", status: "ok" })
      expect(m?.packages.find((p) => p.id === "packages/x86_64-linux/mini")).toMatchObject({
        status: "ok",
      })

      const cfg = embedded<ConfigData>(html, "config/nixos.mini.json")
      expect(cfg?.id).toBe("nixos/mini")
      expect(cfg?.options.length).toBeGreaterThan(0)

      const pkg = embedded<PackageData>(html, "package/packages.x86_64-linux.mini.json")
      expect(pkg?.pname).toBe("mini")
      expect(pkg?.pkgVersion).toBe("0.1.0")
      expect(pkg?.deps.nativeBuildInputs).toEqual(["mini-dep"])
      expect(pkg?.drv?.inputDrvs[0]?.name).toBe("mini-dep")

      const flakeSrc = embedded<FileSource>(html, `file/${encodeURIComponent("self:flake.nix")}`)
      expect(flakeSrc?.text).toContain("flake-explorer test fixture")
      expect(flakeSrc?.tokens.length).toBeGreaterThan(0)

      // The input's own flake.nix (what InputDetail shows) is always embedded.
      expect(
        embedded<FileSource>(html, `file/${encodeURIComponent("input:vendor:flake.nix")}`),
      ).not.toBeNull()

      expect(summary.configs).toEqual(["nixos/mini"])
      expect([...summary.packages].sort()).toEqual([
        "checks/x86_64-linux/mini-check",
        "devShells/x86_64-linux/default",
        "formatter/x86_64-linux",
        "packages/x86_64-linux/mini",
        "packages/x86_64-linux/mini-broken-meta",
      ])
      expect(summary.files).toContain("self:flake.nix")
      expect(summary.htmlBytes).toBe(Buffer.byteLength(html))
    } finally {
      await rm(outDir, { recursive: true, force: true })
    }
  })

  test("extractToDir: a second run hits the cache; bad --configs/--packages ids throw", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "mini-export-"))
    try {
      const flags = {
        out: outDir,
        configs: "all" as const,
        packages: "all" as const,
        allSystems: false,
        timeout: 60,
      }
      await extractToDir(FIXTURE, flags)
      // Fresh manifest + reconcile against the persisted sidecar → skip path.
      const { manifest } = await extractToDir(FIXTURE, flags)
      expect(manifest.configurations[0]!.status).toBe("ok")
      expect(manifest.packages.find((p) => p.id === "packages/x86_64-linux/mini")?.status).toBe(
        "ok",
      )

      await expect(extractToDir(FIXTURE, { ...flags, configs: ["bad-format"] })).rejects.toThrow(
        "--configs takes kind/name ids",
      )
      await expect(extractToDir(FIXTURE, { ...flags, configs: ["nixos/nope"] })).rejects.toThrow(
        "no such configuration",
      )
      await expect(extractToDir(FIXTURE, { ...flags, packages: ["bad-format"] })).rejects.toThrow(
        "--packages takes path/segment ids",
      )
      await expect(
        extractToDir(FIXTURE, { ...flags, packages: ["packages/x86_64-linux/nope"] }),
      ).rejects.toThrow("no such package")
    } finally {
      await rm(outDir, { recursive: true, force: true })
    }
  })

  test("a configuration that fails evaluation lands in status error; export keeps it", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "broken-export-"))
    try {
      const flags = {
        out: outDir,
        configs: "all" as const,
        packages: null,
        allSystems: false,
        timeout: 60,
      }
      const { manifest, wanted, wantedPackages } = await extractToDir(BROKEN, flags)
      const ref = manifest.configurations[0]!
      expect(ref.id).toBe("nixos/broken")
      expect(ref.status).toBe("error")
      expect(ref.error).toContain("nix eval")

      // The export embeds no blob for it but keeps the error ref, so the
      // static UI reports "extraction failed during export: …".
      const htmlPath = join(outDir, "flake.html")
      const summary = await exportHtml(BROKEN, manifest, {
        outDir,
        htmlPath,
        sources: "self",
        timeoutMs: 60_000,
        wanted,
        wantedPackages,
      })
      const em = embedded<Manifest>(await Bun.file(htmlPath).text(), "manifest.json")!
      expect(em.configurations[0]).toMatchObject({ id: "nixos/broken", status: "error" })
      expect(summary.configs).toEqual([])
    } finally {
      await rm(outDir, { recursive: true, force: true })
    }
  })

  test("default export (no --configs/--packages): refs stay pending, self sources still embed", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "mini-export-"))
    try {
      const flags = { out: outDir, configs: null, packages: null, allSystems: false, timeout: 60 }
      const { manifest, wanted, wantedPackages } = await extractToDir(FIXTURE, flags)
      const htmlPath = join(outDir, "flake.html")
      const summary = await exportHtml(FIXTURE, manifest, {
        outDir,
        htmlPath,
        sources: "self",
        timeoutMs: 60_000,
        wanted,
        wantedPackages,
      })
      const html = await Bun.file(htmlPath).text()

      const m = embedded<Manifest>(html, "manifest.json")
      expect(m?.configurations[0]?.status).toBe("pending")
      expect(m?.packages.every((p) => p.status === "pending")).toBe(true)
      expect(embedded(html, "config/nixos.mini.json")).toBeNull()
      expect(embedded(html, "package/packages.x86_64-linux.mini.json")).toBeNull()
      expect(embedded(html, `file/${encodeURIComponent("self:flake.nix")}`)).not.toBeNull()
      expect(summary.configs).toEqual([])
      expect(summary.packages).toEqual([])
    } finally {
      await rm(outDir, { recursive: true, force: true })
    }
  })
})

// Synthetic manifest whose store paths don't exist on disk: exercises the
// degradation paths (blob-missing downgrade, ok-but-unwanted downgrade,
// input re-fetch failure, self-file skip) without needing nix.
describe("exportHtml (synthetic fixture)", () => {
  // Configs and packages share one exportHtml() call (and so one buildApp()
  // bundle build) rather than a test each: bundling the real SPA is the
  // expensive part of this call, and a nix-sandboxed build has much lower
  // resource limits than an interactive shell — enough that one extra
  // `exportHtml` call in this file reproducibly broke Bun's bundler
  // ("Unexpected reading file: .../svelte/.../disclose-version.js") under
  // `nix flake check`'s sandboxed test derivation, deterministic across
  // rebuilds. Not a logic bug in either path — folding them back into one
  // call is the fix.
  test("missing blobs and sources degrade to warnings + pending refs (configs and packages)", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "syn-export-"))
    try {
      const m = fixtureManifest()
      m.configurations[0]!.status = "ok"
      m.configurations.push(
        // ok on disk but NOT requested → downgraded to pending in the embed.
        {
          id: "nixos/other",
          kind: "nixos",
          name: "other",
          dataFile: "config/nixos.other.json",
          status: "ok",
        },
        // requested + "ok" but its blob is missing → warning + downgrade.
        {
          id: "nixos/gone",
          kind: "nixos",
          name: "gone",
          dataFile: "config/nixos.gone.json",
          status: "ok",
        },
      )
      const [hello, devShell] = fixturePackageRefs()
      m.packages = [
        { ...hello!, status: "ok" }, // requested + blob present → stays ok
        { ...devShell!, id: "extra/unrequested", status: "ok" }, // ok but NOT requested → downgrade
      ]
      await Bun.write(join(outDir, "config/nixos.test.json"), JSON.stringify(fixtureConfig()))
      const helloData = {
        version: 1,
        id: hello!.id,
        path: hello!.path,
        pname: "hello",
        builder: "unknown" as const,
        outputs: [],
        deps: { nativeBuildInputs: [], buildInputs: [], propagatedBuildInputs: [] },
        warnings: [],
      }
      await Bun.write(join(outDir, hello!.dataFile), JSON.stringify(helloData))

      const htmlPath = join(outDir, "flake.html")
      const summary = await exportHtml("./no-such-flake", m, {
        outDir,
        htmlPath,
        sources: "all",
        timeoutMs: 10_000,
        wanted: ["nixos/test", "nixos/gone"],
        wantedPackages: [hello!.id, "extra/nope"], // "extra/nope" isn't even in m.packages
      })
      const html = await Bun.file(htmlPath).text()

      expect(embedded<ConfigData>(html, "config/nixos.test.json")?.id).toBe("nixos/test")
      expect(embedded<PackageData>(html, hello!.dataFile)?.pname).toBe("hello")
      const em = embedded<Manifest>(html, "manifest.json")!
      expect(em.configurations.find((c) => c.id === "nixos/test")?.status).toBe("ok")
      expect(em.configurations.find((c) => c.id === "nixos/other")?.status).toBe("pending")
      expect(em.configurations.find((c) => c.id === "nixos/gone")?.status).toBe("pending")
      expect(em.packages.find((p) => p.id === hello!.id)?.status).toBe("ok")
      expect(em.packages.find((p) => p.id === "extra/unrequested")?.status).toBe("pending")
      expect(summary.warnings.some((w) => w.includes("nixos/gone"))).toBe(true)
      expect(summary.packages).toEqual([hello!.id])

      // No fixture store path exists: self files skip with a warning; the
      // config-referenced sops file resolves to an input id, and its nix
      // re-fetch fails (bogus flakeref / no nix) — warned, not embedded.
      expect(summary.files).toEqual([])
      expect(summary.warnings.some((w) => w.includes("self:modules/a.nix"))).toBe(true)
      expect(
        summary.warnings.some((w) => w.includes("input:sops-nix:modules/sops/default.nix")),
      ).toBe(true)
      // Export warnings surface in the embedded manifest for the UI.
      expect(em.warnings.length).toBeGreaterThanOrEqual(summary.warnings.length)
    } finally {
      await rm(outDir, { recursive: true, force: true })
    }
  })
})
