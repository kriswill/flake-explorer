// Dev/explore server: builds the SPA in-memory, serves manifest + config
// blobs from the data dir, and extracts a pending configuration ON DEMAND
// when the UI first requests it (single-flight per config; the request is
// held open until extraction finishes). POST /api/refresh re-runs the
// manifest pass and re-reconciles the cache.

import { mkdirSync } from "node:fs"
import { join, normalize } from "node:path"
import { buildApp, pageHtml } from "./build-app"
import {
  applyExtracted,
  applyExtractedPackage,
  type CacheKey,
  cacheKeyOf,
  extractAndPersist,
  extractAndPersistPackage,
  reconcile,
} from "./extract/cache"
import { tokenizeNix } from "./extract/highlight"
import { buildManifest } from "./extract/manifest"
import { checkNix, readInputFile } from "./extract/run-nix"
import { type Manifest, parseFileId } from "./schema"

export interface ServeFlags {
  out: string
  allSystems: boolean
  timeout: number
  positional: string[]
  port?: number
  /**
   * Interface to bind. Defaults to loopback: the /data/file/ route serves
   * file contents off local disk, so the server is only as trustworthy as
   * everyone who can reach it. Set explicitly (e.g. "0.0.0.0") to expose it.
   */
  host?: string
  /** Watch app/ and rebuild+push-reload the UI bundle; pair with `bun --watch`. */
  dev?: boolean
}

export async function serve(
  flakeRef: string,
  flags: ServeFlags,
): Promise<ReturnType<typeof Bun.serve>> {
  await checkNix()
  const outDir = flags.out
  mkdirSync(join(outDir, "config"), { recursive: true })
  mkdirSync(join(outDir, "package"), { recursive: true })

  console.log(`building UI ...`)
  const title = `flake-explorer — ${flakeRef}`
  const dev = flags.dev ?? false
  let page = pageHtml(await buildApp(dev), title, { dev })

  // Dev mode: rebuild the in-memory bundle when app/ (or the src/ files it
  // pulls in) change, then push a reload to connected browsers over SSE.
  // Server-side .ts changes are bun --watch's job — the process restarts,
  // the SSE connection drops, and the client reloads on reconnect.
  const sseEncoder = new TextEncoder()
  const devClients = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const devNotify = () => {
    for (const c of devClients) {
      try {
        c.enqueue(sseEncoder.encode("data: reload\n\n"))
      } catch {
        devClients.delete(c)
      }
    }
  }
  if (dev) {
    const { watch } = await import("node:fs")
    const repoRoot = join(import.meta.dir, "..")
    let timer: ReturnType<typeof setTimeout> | null = null
    const onChange = (_event: string, filename: string | Buffer | null) => {
      if (!/\.(svelte|ts|css)$/.test(String(filename ?? ""))) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(async () => {
        try {
          const t0 = Date.now()
          page = pageHtml(await buildApp(true, { fresh: true }), title, { dev: true })
          console.log(`dev: UI rebuilt in ${Date.now() - t0}ms — reloading clients`)
          devNotify()
        } catch (e) {
          console.error(`dev: UI rebuild failed: ${String(e).split("\n")[0]}`)
        }
      }, 150)
    }
    watch(join(repoRoot, "app"), { recursive: true }, onChange)
    console.log("dev: watching app/ for UI changes")
  }

  console.log(`extracting manifest of ${flakeRef} ...`)
  let manifest: Manifest = await buildManifest(flakeRef, {
    allSystems: flags.allSystems,
    timeoutMs: flags.timeout * 1000,
  })
  await reconcile(outDir, manifest)

  const inflight = new Map<string, Promise<void>>()

  /** A ref the on-demand extractor can settle onto. */
  interface OnDemandRef {
    status: "pending" | "ok" | "error"
    error?: string
  }

  /**
   * On-demand extraction of one entity (a configuration or a package),
   * single-flighted so concurrent requests for the same id extract once.
   *
   * Configs and packages differ only in which collection they live in and
   * which extract/apply pair they use; everything subtle here — the
   * start-time cache key, the settle-onto-the-current-manifest lookup, and
   * the error stamping — is identical, and was previously duplicated
   * verbatim in two 40-line closures.
   */
  function onDemand<
    R extends { warnings: string[]; durationMs: number },
    T extends OnDemandRef,
  >(spec: {
    /** Keyspace prefix — a package id must never collide with a config id. */
    prefix: string
    id: string
    /** Re-run against the LIVE manifest, which /api/refresh may have swapped. */
    find: (id: string) => T | undefined
    extract: (ref: T, cacheKey: CacheKey) => Promise<R>
    apply: (ref: T, r: R) => void
    starting: (id: string) => string
    finished: (id: string, r: R) => string
  }): Promise<void> {
    const ref = spec.find(spec.id)
    if (!ref || ref.status === "ok") return Promise.resolve()
    const key = `${spec.prefix}${spec.id}`
    let p = inflight.get(key)
    if (!p) {
      // Capture the cache key at extraction START: /api/refresh can swap the
      // manifest mid-extraction, and stamping the new key onto data evaluated
      // from the old flake state would poison the sidecar cache.
      const cacheKey = cacheKeyOf(manifest)
      p = (async () => {
        console.log(spec.starting(spec.id))
        const r = await spec.extract(ref, cacheKey)
        // Settle onto the ref in the CURRENT manifest — /api/refresh may have
        // replaced it while the extraction ran; mutating the stale `ref` would
        // leave the live one pending forever.
        const cur = spec.find(spec.id)
        if (cur) {
          spec.apply(cur, r)
          manifest.warnings.push(...r.warnings)
        }
        console.log(spec.finished(spec.id, r))
      })().catch((e) => {
        const msg = String(e).split("\n").slice(0, 3).join(" ")
        const cur = spec.find(spec.id)
        if (cur) {
          cur.status = "error"
          cur.error = msg
        }
        console.error(`  ${spec.id} failed: ${msg}`)
      })
      inflight.set(key, p)
      void p.finally(() => inflight.delete(key))
    }
    return p
  }

  const extractConfig = (configId: string): Promise<void> =>
    onDemand({
      prefix: "",
      id: configId,
      find: (id) => manifest.configurations.find((c) => c.id === id),
      extract: (ref, cacheKey) =>
        extractAndPersist(outDir, flakeRef, cacheKey, ref, { timeoutMs: flags.timeout * 1000 }),
      apply: applyExtracted,
      starting: (id) => `extracting options of ${id} ...`,
      finished: (id, r) =>
        `  ${id}: ${r.data.options.length} options in ${(r.durationMs / 1000).toFixed(1)}s`,
    })

  const extractPackageOnDemand = (packageId: string): Promise<void> =>
    onDemand({
      prefix: "pkg:",
      id: packageId,
      find: (id) => manifest.packages.find((p) => p.id === id),
      extract: (ref, cacheKey) =>
        extractAndPersistPackage(outDir, flakeRef, cacheKey, ref, {
          timeoutMs: flags.timeout * 1000,
        }),
      apply: applyExtractedPackage,
      starting: (id) => `extracting package ${id} ...`,
      finished: (id, r) =>
        `  ${id}: builder=${r.data.builder} in ${(r.durationMs / 1000).toFixed(1)}s`,
    })

  const server = Bun.serve({
    port: flags.port ?? 4321,
    hostname: flags.host ?? "127.0.0.1",
    idleTimeout: 0, // extraction-held requests can exceed any fixed timeout
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/") {
        return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } })
      }
      if (url.pathname === "/dev/events") {
        if (!dev) return new Response("not found", { status: 404 })
        let ctrl: ReadableStreamDefaultController<Uint8Array>
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            ctrl = c
            devClients.add(c)
            c.enqueue(sseEncoder.encode(": connected\n\n"))
          },
          cancel() {
            devClients.delete(ctrl)
          },
        })
        return new Response(stream, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        })
      }
      if (url.pathname === "/data/manifest.json") {
        return Response.json(manifest)
      }
      const m = url.pathname.match(/^\/data\/((?:config|package)\/[\w@%.+-]+\.json)$/)
      if (m) {
        const rel = decodeURIComponent(m[1]!)
        const isPackage = rel.startsWith("package/")
        const findRef = () =>
          isPackage
            ? manifest.packages.find((p) => p.dataFile === rel)
            : manifest.configurations.find((c) => c.dataFile === rel)
        const ref = findRef()
        // No manifest ref claims this dataFile → 404 before touching disk.
        // This is what keeps sidecar .meta.json files private and stops an
        // encoded ..%2F traversal (the regex admits "%" against the encoded
        // pathname; decodeURIComponent would re-introduce "/") from serving
        // files outside the data dir — only ref-listed blobs are readable.
        if (!ref) return new Response("not found", { status: 404 })
        if (ref.status !== "ok") {
          if (isPackage) await extractPackageOnDemand(ref.id)
          else await extractConfig(ref.id)
          // Re-resolve: extraction settles onto the ref in the manifest that
          // is current at completion (see extractConfig), which /api/refresh
          // may have swapped while we awaited.
          const cur = findRef()
          if (cur?.status !== "ok") {
            return new Response(cur?.error ?? "extraction failed", { status: 500 })
          }
        }
        const file = Bun.file(join(outDir, rel))
        if (!(await file.exists())) return new Response("not found", { status: 404 })
        return new Response(file, { headers: { "content-type": "application/json" } })
      }
      if (url.pathname.startsWith("/data/file/")) {
        // The id alone isn't enough: it only covers self + import-tree files.
        // Option declarations/definitions can point anywhere (e.g. inside
        // nixpkgs itself), so the client resolves and sends the real storePath.
        const storePath = url.searchParams.get("storePath")
        if (!storePath?.startsWith("/")) return new Response("storePath required", { status: 400 })
        // The param names a file to read off local disk, so it must be
        // confined: without this the route hands out any file the serving
        // user can open (~/.ssh/id_rsa, ~/.aws/credentials) to anyone who
        // can reach the port. Legitimate values only ever point into the
        // store or the flake's own tree, which is what readableRoot checks.
        if (!underReadableRoot(storePath, manifest.flake.path)) {
          return new Response("storePath outside the store and flake", { status: 403 })
        }
        let text: string
        const file = Bun.file(storePath)
        if (await file.exists()) {
          text = await file.text()
        } else {
          // A cached ConfigData's storePath can be stale (GC'd, or a lazy-trees
          // synthetic path that was never real to begin with) — for input-origin
          // files, re-fetch straight from the flake input instead of 404ing.
          const id = decodeURIComponent(url.pathname.slice("/data/file/".length))
          const parsed = parseFileId(id)
          if (parsed?.kind !== "input") return new Response("not found", { status: 404 })
          try {
            text = await readInputFile(flakeRef, parsed.input, parsed.relPath, flags.timeout * 1000)
          } catch (e) {
            return new Response(String(e), { status: 500 })
          }
        }
        const tokens = await tokenizeNix(text).catch(() => [])
        return Response.json({ text, tokens })
      }
      if (url.pathname === "/api/refresh" && req.method === "POST") {
        console.log("refreshing manifest ...")
        manifest = await buildManifest(flakeRef, {
          allSystems: flags.allSystems,
          timeoutMs: flags.timeout * 1000,
        })
        await reconcile(outDir, manifest)
        return Response.json({ ok: true })
      }
      return new Response("not found", { status: 404 })
    },
  })

  console.log(`flake-explorer serving ${flakeRef} at http://localhost:${server.port}`)
  return server
}

/**
 * Roots the /data/file/ route may read from: the Nix store (where every
 * option declaration/definition path lives) and the flake's own tree (which
 * under lazy-trees IS the working directory, not a store copy).
 *
 * Compared after normalization so `..` cannot walk out, and with a trailing
 * separator so a sibling like `/nix/store-evil` can't pass as `/nix/store`.
 * The flake root is allowed to equal the path itself; the store never is.
 */
export function underReadableRoot(candidate: string, flakePath: string): boolean {
  const path = normalize(candidate)
  if (path.startsWith("/nix/store/")) return true
  if (!flakePath) return false
  const root = normalize(flakePath)
  return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`)
}
