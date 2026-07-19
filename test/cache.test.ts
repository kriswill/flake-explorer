import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  applyExtracted,
  applyExtractedPackage,
  cacheKeyOf,
  extractAndPersist,
  extractAndPersistPackage,
  reconcile,
  writeSidecar,
} from "../src/extract/cache"
import type { ConfigRef, Manifest, PackageRef } from "../src/schema"
import { fixtureManifest } from "./fixtures/data"

const NAR = "sha256-NNNN"

// fixtureManifest with one pending configuration and a known narHash — the
// state serve/extract hand to reconcile() right after buildManifest.
const pendingManifest = (narHash?: string): Manifest => {
  const m = fixtureManifest()
  m.flake.narHash = narHash
  m.configurations = [
    {
      id: "nixos/test",
      kind: "nixos",
      name: "test",
      dataFile: "config/nixos.test.json",
      status: "pending",
    },
  ]
  return m
}

describe("reconcile / writeSidecar", () => {
  let outDir: string
  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "cache-test-"))
  })
  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true })
  })

  const ref = { dataFile: "config/nixos.test.json" }
  const blobPath = () => join(outDir, ref.dataFile)
  const sidecarPath = () => join(outDir, "config/nixos.test.meta.json")
  // The key a fresh extraction of pendingManifest(NAR) would stamp.
  const key = cacheKeyOf(pendingManifest(NAR))
  const meta = {
    ...key,
    extractedAt: "2026-07-08T12:00:00Z",
    optionCount: 42,
    durationMs: 1234,
    warnings: ["eval hiccup"],
  }

  test("matching sidecar flips status to ok and copies extraction stats", async () => {
    await Bun.write(blobPath(), "{}")
    await writeSidecar(outDir, ref, meta)
    const m = pendingManifest(NAR)
    await reconcile(outDir, m)
    const c = m.configurations[0]!
    expect(c.status).toBe("ok")
    expect(c.extractedAt).toBe(meta.extractedAt)
    expect(c.optionCount).toBe(meta.optionCount)
    expect(c.durationMs).toBe(meta.durationMs)
    expect(m.warnings).toContain("[cached] eval hiccup")
  })

  test("extractor version mismatch stays pending", async () => {
    await Bun.write(blobPath(), "{}")
    await Bun.write(sidecarPath(), JSON.stringify({ ...meta, extractor: "bogus" }))
    const m = pendingManifest(NAR)
    await reconcile(outDir, m)
    expect(m.configurations[0]!.status).toBe("pending")
    expect(m.warnings).toEqual([])
  })

  test("flakeKey (narHash) mismatch stays pending", async () => {
    await Bun.write(blobPath(), "{}")
    await writeSidecar(outDir, ref, { ...meta, flakeKey: "sha256-OTHER" })
    const m = pendingManifest(NAR)
    await reconcile(outDir, m)
    expect(m.configurations[0]!.status).toBe("pending")
  })

  test("lockHash mismatch stays pending even when the flakeKey matches", async () => {
    await Bun.write(blobPath(), "{}")
    await writeSidecar(outDir, ref, { ...meta, lockHash: "0000000000000000" })
    const m = pendingManifest(NAR)
    await reconcile(outDir, m)
    expect(m.configurations[0]!.status).toBe("pending")
  })

  test("manifest without narHash falls back to the self store path as identity", async () => {
    // No narHash (dirty local checkout): the content-addressed self path
    // stands in, so a matching sidecar is fresh ...
    await Bun.write(blobPath(), "{}")
    const m = pendingManifest(undefined)
    await writeSidecar(outDir, ref, { ...meta, ...cacheKeyOf(m) })
    await reconcile(outDir, m)
    expect(m.configurations[0]!.status).toBe("ok")

    // ... and one recorded from different flake content is not.
    const m2 = pendingManifest(undefined)
    m2.flake.path = "/nix/store/ffffffffffffffffffffffffffffffff-source"
    await reconcile(outDir, m2)
    expect(m2.configurations[0]!.status).toBe("pending")
  })

  test("pre-CacheKey sidecar (bare narHash, no flakeKey) stays pending", async () => {
    await Bun.write(blobPath(), "{}")
    const { flakeKey: _f, lockHash: _l, ...legacy } = meta
    await Bun.write(sidecarPath(), JSON.stringify({ ...legacy, narHash: NAR, extractor: "0.4.0" }))
    const m = pendingManifest(NAR)
    await reconcile(outDir, m)
    expect(m.configurations[0]!.status).toBe("pending")
  })

  test("sidecar without a blob stays pending", async () => {
    await writeSidecar(outDir, ref, meta)
    const m = pendingManifest(NAR)
    await reconcile(outDir, m)
    expect(m.configurations[0]!.status).toBe("pending")
  })

  test("blob without a sidecar stays pending", async () => {
    await Bun.write(blobPath(), "{}")
    const m = pendingManifest(NAR)
    await reconcile(outDir, m)
    expect(m.configurations[0]!.status).toBe("pending")
  })

  test("corrupt sidecar JSON stays pending", async () => {
    await Bun.write(blobPath(), "{}")
    await Bun.write(sidecarPath(), '{"extractor":"0.2')
    const m = pendingManifest(NAR)
    await reconcile(outDir, m)
    expect(m.configurations[0]!.status).toBe("pending")
  })

  test("extractAndPersist refuses a dataFile escaping the data dir", async () => {
    // Never reaches nix: the traversal guard fires before any evaluation.
    await expect(
      extractAndPersist(
        outDir,
        "/flake",
        key,
        { kind: "nixos", name: "evil", dataFile: "../evil.json" },
        { timeoutMs: 1_000 },
      ),
    ).rejects.toThrow("refusing to write outside the data dir: ../evil.json")
  })
})

// fixtureManifest with one pending package and a known narHash — mirrors
// pendingManifest above; reconcile shares one code path (reconcileRef) for
// both, so these tests focus on the package-specific wrinkle (no
// optionCount) rather than re-covering every freshness scenario above.
const pendingPackageManifest = (narHash?: string): Manifest => {
  const m = fixtureManifest()
  m.flake.narHash = narHash
  m.packages = [
    {
      id: "packages/x86_64-linux/hello",
      path: ["packages", "x86_64-linux", "hello"],
      dataFile: "package/packages.x86_64-linux.hello.json",
      status: "pending",
    },
  ]
  return m
}

describe("reconcile: packages", () => {
  let outDir: string
  beforeEach(async () => {
    outDir = await mkdtemp(join(tmpdir(), "cache-test-pkg-"))
  })
  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true })
  })

  const ref = { dataFile: "package/packages.x86_64-linux.hello.json" }
  const blobPath = () => join(outDir, ref.dataFile)
  const key = cacheKeyOf(pendingPackageManifest(NAR))
  const meta = {
    ...key,
    extractedAt: "2026-07-08T12:00:00Z",
    durationMs: 1234,
    warnings: ["meta unavailable for packages/x86_64-linux/hello (broken/unfree package?)"],
  }

  test("matching sidecar flips a package ref to ok without ever gaining optionCount", async () => {
    await Bun.write(blobPath(), "{}")
    await writeSidecar(outDir, ref, meta)
    const m = pendingPackageManifest(NAR)
    await reconcile(outDir, m)
    const p = m.packages[0]!
    expect(p.status).toBe("ok")
    expect(p.extractedAt).toBe(meta.extractedAt)
    expect(p.durationMs).toBe(meta.durationMs)
    expect(Object.hasOwn(p, "optionCount")).toBe(false)
    expect(m.warnings).toContain(
      "[cached] meta unavailable for packages/x86_64-linux/hello (broken/unfree package?)",
    )
  })

  test("flakeKey mismatch stays pending, same as configurations", async () => {
    await Bun.write(blobPath(), "{}")
    await writeSidecar(outDir, ref, { ...meta, flakeKey: "sha256-OTHER" })
    const m = pendingPackageManifest(NAR)
    await reconcile(outDir, m)
    expect(m.packages[0]!.status).toBe("pending")
  })

  test("reconcile covers configurations and packages in the same pass", async () => {
    const cfgRef = { dataFile: "config/nixos.test.json" }
    await Bun.write(join(outDir, cfgRef.dataFile), "{}")
    await writeSidecar(outDir, cfgRef, {
      ...key,
      extractedAt: "2026-07-08T12:00:00Z",
      optionCount: 3,
      durationMs: 10,
      warnings: [],
    })
    await Bun.write(blobPath(), "{}")
    await writeSidecar(outDir, ref, meta)

    const m = pendingPackageManifest(NAR)
    m.configurations = [
      {
        id: "nixos/test",
        kind: "nixos",
        name: "test",
        dataFile: cfgRef.dataFile,
        status: "pending",
      },
    ]
    await reconcile(outDir, m)
    expect(m.configurations[0]!.status).toBe("ok")
    expect(m.packages[0]!.status).toBe("ok")
  })

  test("extractAndPersistPackage refuses a dataFile escaping the data dir", async () => {
    await expect(
      extractAndPersistPackage(
        outDir,
        "/flake",
        key,
        { id: "evil", path: ["evil"], dataFile: "../evil.json" },
        { timeoutMs: 1_000 },
      ),
    ).rejects.toThrow("refusing to write outside the data dir: ../evil.json")
  })
})

describe("cacheKeyOf", () => {
  test("prefers narHash, falls back to the self store path", () => {
    const m = fixtureManifest()
    m.flake.narHash = NAR
    expect(cacheKeyOf(m).flakeKey).toBe(NAR)
    m.flake.narHash = undefined
    expect(cacheKeyOf(m).flakeKey).toBe(m.flake.path)
  })

  test("lockHash tracks input identity, not object key order", () => {
    const m = fixtureManifest()
    const base = cacheKeyOf(m).lockHash

    // Same inputs, reversed insertion order → same hash.
    const reordered = fixtureManifest()
    reordered.inputs = Object.fromEntries(Object.entries(reordered.inputs).reverse())
    expect(cacheKeyOf(reordered).lockHash).toBe(base)

    // One input moves to a new narHash → different hash.
    const bumped = fixtureManifest()
    const name = Object.keys(bumped.inputs)[0]!
    bumped.inputs[name] = { ...bumped.inputs[name]!, narHash: "sha256-MOVED" }
    expect(cacheKeyOf(bumped).lockHash).not.toBe(base)
  })
})

describe("applyExtractedPackage", () => {
  test("stamps extraction stats onto the current-manifest ref", () => {
    const ref: PackageRef = {
      id: "packages/x86_64-linux/hello",
      path: ["packages", "x86_64-linux", "hello"],
      dataFile: "package/packages.x86_64-linux.hello.json",
      status: "pending",
    }
    applyExtractedPackage(ref, {
      data: {
        version: 1,
        id: ref.id,
        path: ref.path,
        builder: "unknown",
        outputs: [],
        deps: { nativeBuildInputs: [], buildInputs: [], propagatedBuildInputs: [] },
        warnings: [],
      },
      warnings: [],
      durationMs: 999,
      extractedAt: "2026-07-08T12:00:00Z",
    })
    expect(ref.status).toBe("ok")
    expect(ref.extractedAt).toBe("2026-07-08T12:00:00Z")
    expect(ref.durationMs).toBe(999)
    expect(Object.hasOwn(ref, "optionCount")).toBe(false)
  })
})

describe("applyExtracted", () => {
  test("stamps extraction stats onto the current-manifest ref", () => {
    const ref: ConfigRef = {
      id: "nixos/test",
      kind: "nixos",
      name: "test",
      dataFile: "config/nixos.test.json",
      status: "pending",
    }
    applyExtracted(ref, {
      data: { version: 1, id: "nixos/test", options: [], fileIndex: {} },
      warnings: [],
      durationMs: 1234,
      extractedAt: "2026-07-08T12:00:00Z",
    })
    expect(ref.status).toBe("ok")
    expect(ref.extractedAt).toBe("2026-07-08T12:00:00Z")
    expect(ref.optionCount).toBe(0)
    expect(ref.durationMs).toBe(1234)
  })
})
