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
import { checkNix, readInputFile } from "./extract/run-nix";
import type { Manifest } from "./schema";

export interface ServeFlags {
  out: string;
  allSystems: boolean;
  timeout: number;
  positional: string[];
  port?: number;
  /** Watch app/ and rebuild+push-reload the UI bundle; pair with `bun --watch`. */
  dev?: boolean;
}

export async function serve(flakeRef: string, flags: ServeFlags): Promise<void> {
  await checkNix();
  const outDir = flags.out;
  mkdirSync(join(outDir, "config"), { recursive: true });

  console.log(`building UI ...`);
  const title = `flake-explorer — ${flakeRef}`;
  const dev = flags.dev ?? false;
  let page = pageHtml(await buildApp(dev), title, { dev });

  // Dev mode: rebuild the in-memory bundle when app/ (or the src/ files it
  // pulls in) change, then push a reload to connected browsers over SSE.
  // Server-side .ts changes are bun --watch's job — the process restarts,
  // the SSE connection drops, and the client reloads on reconnect.
  const sseEncoder = new TextEncoder();
  const devClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const devNotify = () => {
    for (const c of devClients) {
      try {
        c.enqueue(sseEncoder.encode("data: reload\n\n"));
      } catch {
        devClients.delete(c);
      }
    }
  };
  if (dev) {
    const { watch } = await import("node:fs");
    const repoRoot = join(import.meta.dir, "..");
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onChange = (_event: string, filename: string | Buffer | null) => {
      if (!/\.(svelte|ts|css)$/.test(String(filename ?? ""))) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          const t0 = Date.now();
          page = pageHtml(await buildApp(true), title, { dev: true });
          console.log(`dev: UI rebuilt in ${Date.now() - t0}ms — reloading clients`);
          devNotify();
        } catch (e) {
          console.error(`dev: UI rebuild failed: ${String(e).split("\n")[0]}`);
        }
      }, 150);
    };
    watch(join(repoRoot, "app"), { recursive: true }, onChange);
    console.log("dev: watching app/ for UI changes");
  }

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
      if (url.pathname === "/dev/events") {
        if (!dev) return new Response("not found", { status: 404 });
        let ctrl: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            ctrl = c;
            devClients.add(c);
            c.enqueue(sseEncoder.encode(": connected\n\n"));
          },
          cancel() {
            devClients.delete(ctrl);
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        });
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
      if (url.pathname.startsWith("/data/file/")) {
        // The id alone isn't enough: it only covers self + import-tree files.
        // Option declarations/definitions can point anywhere (e.g. inside
        // nixpkgs itself), so the client resolves and sends the real storePath.
        const storePath = url.searchParams.get("storePath");
        if (!storePath?.startsWith("/")) return new Response("storePath required", { status: 400 });
        let text: string;
        const file = Bun.file(storePath);
        if (await file.exists()) {
          text = await file.text();
        } else {
          // A cached ConfigData's storePath can be stale (GC'd, or a lazy-trees
          // synthetic path that was never real to begin with) — for input-origin
          // files, re-fetch straight from the flake input instead of 404ing.
          const id = decodeURIComponent(url.pathname.slice("/data/file/".length));
          const inputMatch = id.match(/^input:([^:]+):(.+)$/);
          if (!inputMatch) return new Response("not found", { status: 404 });
          try {
            text = await readInputFile(flakeRef, inputMatch[1]!, inputMatch[2]!, flags.timeout * 1000);
          } catch (e) {
            return new Response(String(e), { status: 500 });
          }
        }
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
