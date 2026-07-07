// Dev/explore server: builds the SPA in-memory, serves manifest + config
// blobs from the data dir, and extracts a pending configuration ON DEMAND
// when the UI first requests it (single-flight per config; the request is
// held open until extraction finishes). POST /api/refresh re-runs the
// manifest pass and re-reconciles the cache.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildApp, pageHtml } from "./build-app";
import { reconcile, writeSidecar } from "./extract/cache";
import { tokenizeNix } from "./extract/highlight";
import { buildManifest } from "./extract/manifest";
import { extractOptions } from "./extract/options";
import { checkNix } from "./extract/run-nix";
import type { Manifest } from "./schema";

export interface ServeFlags {
  out: string;
  allSystems: boolean;
  timeout: number;
  positional: string[];
  port?: number;
}

export async function serve(flakeRef: string, flags: ServeFlags): Promise<void> {
  await checkNix();
  const outDir = flags.out;
  mkdirSync(join(outDir, "config"), { recursive: true });

  console.log(`building UI ...`);
  const page = pageHtml(await buildApp(), `flake-explorer — ${flakeRef}`);

  console.log(`extracting manifest of ${flakeRef} ...`);
  let manifest: Manifest = await buildManifest(flakeRef, {
    allSystems: flags.allSystems,
    timeoutMs: flags.timeout * 1000,
  });
  await reconcile(outDir, manifest);

  const inflight = new Map<string, Promise<void>>();

  async function extractConfig(configId: string): Promise<void> {
    const ref = manifest.configurations.find((c) => c.id === configId);
    if (!ref || ref.status === "ok") return;
    let p = inflight.get(configId);
    if (!p) {
      p = (async () => {
        console.log(`extracting options of ${configId} ...`);
        const r = await extractOptions(flakeRef, ref.kind, ref.name, { timeoutMs: flags.timeout * 1000 });
        await Bun.write(join(outDir, ref.dataFile), JSON.stringify(r.data));
        await writeSidecar(outDir, ref, {
          narHash: manifest.flake.narHash,
          extractedAt: new Date().toISOString(),
          optionCount: r.data.options.length,
          durationMs: r.durationMs,
          warnings: r.warnings,
        });
        ref.status = "ok";
        ref.optionCount = r.data.options.length;
        manifest.warnings.push(...r.warnings);
        console.log(`  ${configId}: ${r.data.options.length} options in ${(r.durationMs / 1000).toFixed(1)}s`);
      })().catch((e) => {
        ref.status = "error";
        ref.error = String(e).split("\n").slice(0, 3).join(" ");
        console.error(`  ${configId} failed: ${ref.error}`);
      });
      inflight.set(configId, p);
      void p.finally(() => inflight.delete(configId));
    }
    return p;
  }

  const server = Bun.serve({
    port: flags.port ?? 4321,
    idleTimeout: 0, // extraction-held requests can exceed any fixed timeout
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/") {
        return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (url.pathname === "/data/manifest.json") {
        return Response.json(manifest);
      }
      const m = url.pathname.match(/^\/data\/(config\/[\w@%.+-]+\.json)$/);
      if (m) {
        const rel = decodeURIComponent(m[1]!);
        const ref = manifest.configurations.find((c) => c.dataFile === rel);
        if (ref && ref.status !== "ok") {
          await extractConfig(ref.id);
          // extractConfig mutates ref.status; TS's narrowing doesn't know.
          if ((ref.status as string) !== "ok") {
            return new Response(ref.error ?? "extraction failed", { status: 500 });
          }
        }
        const file = Bun.file(join(outDir, rel));
        if (!(await file.exists())) return new Response("not found", { status: 404 });
        return new Response(file, { headers: { "content-type": "application/json" } });
      }
      const fm = url.pathname.match(/^\/data\/file\/(.+)$/);
      if (fm) {
        const entry = manifest.files.find((f) => f.id === decodeURIComponent(fm[1]!));
        if (!entry) return new Response("not found", { status: 404 });
        const file = Bun.file(entry.storePath);
        if (!(await file.exists())) return new Response("not found", { status: 404 });
        const text = await file.text();
        const tokens = await tokenizeNix(text).catch(() => []);
        return Response.json({ text, tokens });
      }
      if (url.pathname === "/api/refresh" && req.method === "POST") {
        console.log("refreshing manifest ...");
        manifest = await buildManifest(flakeRef, {
          allSystems: flags.allSystems,
          timeoutMs: flags.timeout * 1000,
        });
        await reconcile(outDir, manifest);
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  });

  console.log(`flake-explorer serving ${flakeRef} at http://localhost:${server.port}`);
}
