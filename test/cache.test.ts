import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { reconcile, writeSidecar } from "../src/extract/cache";
import type { Manifest } from "../src/schema";
import { fixtureManifest } from "./fixtures/data";

const SCRATCH =
  "/tmp/claude-1000/-home-k-src-flake-explorer/8b9cf510-ad58-4f78-84a7-bba3ac1e3cce/scratchpad";
const NAR = "sha256-NNNN";

// fixtureManifest with one pending configuration and a known narHash — the
// state serve/extract hand to reconcile() right after buildManifest.
const pendingManifest = (narHash?: string): Manifest => {
  const m = fixtureManifest();
  m.flake.narHash = narHash;
  m.configurations = [
    {
      id: "nixos/test",
      kind: "nixos",
      name: "test",
      dataFile: "config/nixos.test.json",
      status: "pending",
    },
  ];
  return m;
};

describe("reconcile / writeSidecar", () => {
  let outDir: string;
  beforeEach(async () => {
    outDir = await mkdtemp(join(SCRATCH, "cache-test-"));
  });
  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  const ref = { dataFile: "config/nixos.test.json" };
  const blobPath = () => join(outDir, ref.dataFile);
  const sidecarPath = () => join(outDir, "config/nixos.test.meta.json");
  const meta = {
    narHash: NAR,
    extractedAt: "2026-07-08T12:00:00Z",
    optionCount: 42,
    durationMs: 1234,
    warnings: ["eval hiccup"],
  };

  test("matching sidecar flips status to ok and copies extraction stats", async () => {
    await Bun.write(blobPath(), "{}");
    await writeSidecar(outDir, ref, meta);
    const m = pendingManifest(NAR);
    await reconcile(outDir, m);
    const c = m.configurations[0]!;
    expect(c.status).toBe("ok");
    expect(c.extractedAt).toBe(meta.extractedAt);
    expect(c.optionCount).toBe(meta.optionCount);
    expect(c.durationMs).toBe(meta.durationMs);
    expect(m.warnings).toContain("[cached] eval hiccup");
  });

  test("extractor version mismatch stays pending", async () => {
    await Bun.write(blobPath(), "{}");
    await Bun.write(sidecarPath(), JSON.stringify({ ...meta, extractor: "bogus" }));
    const m = pendingManifest(NAR);
    await reconcile(outDir, m);
    expect(m.configurations[0]!.status).toBe("pending");
    expect(m.warnings).toEqual([]);
  });

  test("narHash mismatch stays pending", async () => {
    await Bun.write(blobPath(), "{}");
    await writeSidecar(outDir, ref, { ...meta, narHash: "sha256-OTHER" });
    const m = pendingManifest(NAR);
    await reconcile(outDir, m);
    expect(m.configurations[0]!.status).toBe("pending");
  });

  test("manifest without narHash accepts a sidecar with any narHash", async () => {
    // Documents current lenient behavior: no narHash on the flake means the
    // hash check is skipped entirely.
    await Bun.write(blobPath(), "{}");
    await writeSidecar(outDir, ref, { ...meta, narHash: "sha256-WHATEVER" });
    const m = pendingManifest(undefined);
    await reconcile(outDir, m);
    expect(m.configurations[0]!.status).toBe("ok");
  });

  test("sidecar without a blob stays pending", async () => {
    await writeSidecar(outDir, ref, meta);
    const m = pendingManifest(NAR);
    await reconcile(outDir, m);
    expect(m.configurations[0]!.status).toBe("pending");
  });

  test("blob without a sidecar stays pending", async () => {
    await Bun.write(blobPath(), "{}");
    const m = pendingManifest(NAR);
    await reconcile(outDir, m);
    expect(m.configurations[0]!.status).toBe("pending");
  });

  test("corrupt sidecar JSON stays pending", async () => {
    await Bun.write(blobPath(), "{}");
    await Bun.write(sidecarPath(), '{"extractor":"0.2');
    const m = pendingManifest(NAR);
    await reconcile(outDir, m);
    expect(m.configurations[0]!.status).toBe("pending");
  });
});
