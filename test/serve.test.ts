// Integration test of the serve layer: Bun.serve routing + the on-demand
// single-flight extraction, hermetic via a scripted `nix` shim on PATH (the
// technique from run-nix.test.ts). One real server is started once (the SPA
// bundle build is a few seconds) and all tests run against it in order —
// later tests intentionally depend on state earlier ones created.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import type { ConfigData, Manifest } from "../src/schema"
import { serve } from "../src/serve"

// The happy-dom preload (test/setup/happy-dom.ts) replaces global fetch /
// Response / ReadableStream with happy-dom's classes, and Bun.serve rejects
// handler responses that aren't its own Response. This file needs the real
// network stack, not a DOM — unregister happy-dom for its duration and
// re-register in afterAll so later test files still get their DOM globals
// (bun test runs all files sequentially in one process).
const httpFetch = (input: string, init?: RequestInit): Promise<Response> =>
  globalThis.fetch(input, init)

const FLAKE_REF = "github:example/shim-flake" // deliberately NOT path-like: keeps git/localCheckout logic off
const SELF = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-source"

// Scripted fake nix. Fixture JSON lives in $NIX_SHIM_DIR; every handled call
// appends its mode to $NIX_SHIM_LOG so tests can count invocations. The
// options eval sleeps so concurrent requests overlap (single-flight proof).
// The eval --expr argv embeds the args JSON with escaped quotes, so the
// patterns match the literal backslash-quote sequences.
const SHIM = `#!/bin/sh
log() { printf '%s\\n' "$1" >> "$NIX_SHIM_LOG"; }
case "$*" in
  *--version*) log version; echo "nix (Nix) 2.34.7" ;;
  *"flake metadata"*) log metadata; cat "$NIX_SHIM_DIR/metadata.json" ;;
  *"flake show"*) log show; cat "$NIX_SHIM_DIR/show.json" ;;
  *'mode\\":\\"manifest'*) log manifest; cat "$NIX_SHIM_DIR/manifest-eval.json" ;;
  *'mode\\":\\"optionNames'*)
    log optionNames
    if [ -e "$NIX_SHIM_DIR/fail-optionNames" ]; then echo "error: shim optionNames refused" >&2; exit 1; fi
    cat "$NIX_SHIM_DIR/option-names.json" ;;
  *'mode\\":\\"options'*) log options; sleep 0.3; cat "$NIX_SHIM_DIR/options-eval.json" ;;
  *"builtins.readFile"*)
    log readFile
    if [ -e "$NIX_SHIM_DIR/input-file.nix" ]; then cat "$NIX_SHIM_DIR/input-file.nix"; else echo "error: shim input file gone" >&2; exit 1; fi ;;
  *) echo "nix shim: unexpected argv: $*" >&2; exit 9 ;;
esac
`

// nix flake metadata --json: one simple locked input, resolvedUrl not
// path-like so detectLocalCheckout stays null (no git calls).
const METADATA = {
  description: "shim test flake",
  path: SELF,
  resolvedUrl: FLAKE_REF,
  url: FLAKE_REF,
  revision: "deadbeef",
  locked: { narHash: "sha256-selfnarhash=", rev: "deadbeef" },
  locks: {
    version: 7,
    root: "root",
    nodes: {
      root: { inputs: { nixpkgs: "nixpkgs" } },
      nixpkgs: {
        locked: {
          type: "github",
          owner: "NixOS",
          repo: "nixpkgs",
          rev: "cafebabe",
          narHash: "sha256-nixpkgsnarhash=",
          lastModified: 1700000000,
        },
        original: { type: "github", owner: "NixOS", repo: "nixpkgs" },
      },
    },
  },
}

// nix flake show --json (classic format): one nixosConfiguration, no
// packages/devShells/checks/formatter — so derivation show / path-info
// never fire and packageRefs stays empty.
const SHOW = { nixosConfigurations: { test: { type: "nixos-configuration" } } }

// extract.nix mode=manifest: empty files list keeps importGraph trivial.
const MANIFEST_EVAL = {
  self: SELF,
  description: "shim test flake",
  inputs: { nixpkgs: { path: "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-source", inputs: {} } },
  configurations: [{ kind: "nixos", n: "test" }],
  files: [],
  grafts: [],
  outputNames: {},
}

// mode=optionNames: a single namespace → exactly one options chunk per
// extraction run (1 optionNames + 1 options eval).
const OPTION_NAMES = ["services"]

const OPTIONS_EVAL = {
  options: [
    {
      loc: ["services", "demo", "enable"],
      type: "boolean",
      description: "Demo option.",
      readOnly: false,
      isDefined: true,
      highestPrio: 100,
      defaultText: null,
      default: { ok: false },
      value: { ok: true },
      declarations: [{ file: `${SELF}/module.nix`, line: null, column: null }],
      definitions: [{ file: `${SELF}/module.nix`, value: { ok: true } }],
    },
  ],
}

let shimDir: string
let dataParent: string // holds dataDir + a sentinel file for the traversal probe
let dataDir: string
let logFile: string
let server: Awaited<ReturnType<typeof serve>>
let base: string
const origPath = process.env.PATH

/** Shim invocations per mode since the log was last reset. */
async function shimCounts(): Promise<Record<string, number>> {
  const text = await Bun.file(logFile)
    .text()
    .catch(() => "")
  const counts: Record<string, number> = {}
  for (const line of text.split("\n")) {
    if (line) counts[line] = (counts[line] ?? 0) + 1
  }
  return counts
}

const resetShimLog = () => Bun.write(logFile, "")

const blobPath = () => join(dataDir, "config/nixos.test.json")
const sidecarPath = () => join(dataDir, "config/nixos.test.meta.json")

const getManifest = async (): Promise<Manifest> =>
  (await (await httpFetch(`${base}/data/manifest.json`)).json()) as Manifest

beforeAll(async () => {
  await GlobalRegistrator.unregister()

  shimDir = await mkdtemp(join(tmpdir(), "serve-shim-"))
  dataParent = await mkdtemp(join(tmpdir(), "serve-data-"))
  dataDir = join(dataParent, "out")
  logFile = join(shimDir, "calls.log")

  // A file OUTSIDE the data dir, to probe path-traversal containment.
  await Bun.write(join(dataParent, "outside.json"), '{"leaked":true}')

  await Bun.write(join(shimDir, "nix"), SHIM)
  await chmod(join(shimDir, "nix"), 0o755)
  await Bun.write(join(shimDir, "metadata.json"), JSON.stringify(METADATA))
  await Bun.write(join(shimDir, "show.json"), JSON.stringify(SHOW))
  await Bun.write(join(shimDir, "manifest-eval.json"), JSON.stringify(MANIFEST_EVAL))
  await Bun.write(join(shimDir, "option-names.json"), JSON.stringify(OPTION_NAMES))
  await Bun.write(join(shimDir, "options-eval.json"), JSON.stringify(OPTIONS_EVAL))

  process.env.PATH = `${shimDir}:${origPath}`
  process.env.NIX_SHIM_DIR = shimDir
  process.env.NIX_SHIM_LOG = logFile

  // port 0 = kernel-assigned free port, read back from the handle.
  server = await serve(FLAKE_REF, {
    out: dataDir,
    allSystems: false,
    timeout: 60,
    positional: [],
    port: 0,
  })
  base = `http://localhost:${server.port}`
})

afterAll(async () => {
  server?.stop(true)
  process.env.PATH = origPath
  delete process.env.NIX_SHIM_DIR
  delete process.env.NIX_SHIM_LOG
  await rm(shimDir, { recursive: true, force: true })
  await rm(dataParent, { recursive: true, force: true })

  // Restore the DOM environment (and the preload's fallbacks) for any test
  // files that run after this one.
  GlobalRegistrator.register()
  const g = globalThis as Record<string, unknown>
  if (typeof g.matchMedia !== "function") {
    g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  }
  if (typeof g.ResizeObserver !== "function") {
    g.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  }
})

describe("serve routing + on-demand extraction (shimmed nix)", () => {
  test("GET / serves the built SPA page", async () => {
    const res = await httpFetch(`${base}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    const html = await res.text()
    expect(html).toContain('<div id="app">')
    expect(html).toContain('<script type="module">')
    expect(html).toContain(`flake-explorer — ${FLAKE_REF}`)
  })

  test("GET /data/manifest.json: shim-built manifest, config pending (nothing to reconcile)", async () => {
    const manifest = await getManifest()
    expect(manifest.configurations).toHaveLength(1)
    expect(manifest.configurations[0]).toMatchObject({
      id: "nixos/test",
      kind: "nixos",
      name: "test",
      dataFile: "config/nixos.test.json",
      status: "pending",
    })
    expect(manifest.flake.narHash).toBe("sha256-selfnarhash=")
    expect(manifest.packages).toHaveLength(0)
    expect(Object.keys(manifest.inputs)).toEqual(["nixpkgs"])
  })

  test("GET /data/config/nixos.test.json is held open until extraction completes", async () => {
    await resetShimLog()
    const t0 = performance.now()
    const res = await httpFetch(`${base}/data/config/nixos.test.json`)
    const elapsed = performance.now() - t0
    expect(res.status).toBe(200)
    // The shim's options eval sleeps 300ms — the response cannot have
    // arrived earlier than that if the request was truly held open.
    expect(elapsed).toBeGreaterThan(250)

    const data = (await res.json()) as ConfigData
    expect(data.id).toBe("nixos/test")
    expect(data.options).toHaveLength(1)
    expect(data.options[0]!.loc).toEqual(["services", "demo", "enable"])

    // Blob + sidecar landed in the data dir; manifest flipped to ok.
    expect(await Bun.file(blobPath()).exists()).toBe(true)
    expect(await Bun.file(sidecarPath()).exists()).toBe(true)
    const manifest = await getManifest()
    expect(manifest.configurations[0]!.status).toBe("ok")
    expect(manifest.configurations[0]!.optionCount).toBe(1)

    // Baseline for the single-flight test: one extraction run is exactly
    // one optionNames eval + one options eval (single namespace fixture).
    expect(await shimCounts()).toEqual({ optionNames: 1, options: 1 })
  }, 15_000)

  test("single-flight: two concurrent requests for a pending config extract once", async () => {
    // Make the config pending again: drop blob+sidecar, refresh re-builds
    // the manifest and reconcile finds nothing on disk.
    await unlink(blobPath())
    await unlink(sidecarPath())
    const refresh = await httpFetch(`${base}/api/refresh`, { method: "POST" })
    expect(await refresh.json()).toEqual({ ok: true })
    expect((await getManifest()).configurations[0]!.status).toBe("pending")

    await resetShimLog()
    const [a, b] = await Promise.all([
      httpFetch(`${base}/data/config/nixos.test.json`),
      httpFetch(`${base}/data/config/nixos.test.json`),
    ])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    const [da, db] = (await Promise.all([a.json(), b.json()])) as ConfigData[]
    expect(da.id).toBe("nixos/test")
    expect(db).toEqual(da)

    // Same eval counts as ONE sequential extraction (previous test): the
    // second request rode the in-flight promise instead of re-evaluating.
    expect(await shimCounts()).toEqual({ optionNames: 1, options: 1 })
  }, 15_000)

  test("POST /api/refresh reconciles the extracted config back to ok from its sidecar", async () => {
    const res = await httpFetch(`${base}/api/refresh`, { method: "POST" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    await resetShimLog()
    const manifest = await getManifest()
    expect(manifest.configurations[0]!.status).toBe("ok")
    expect(manifest.configurations[0]!.optionCount).toBe(1)
    // ...and serving the blob after reconcile needs no re-extraction.
    const blob = await httpFetch(`${base}/data/config/nixos.test.json`)
    expect(blob.status).toBe(200)
    expect(await shimCounts()).toEqual({})
  })

  test("route guards: unknown /data paths 404", async () => {
    // fetch/URL normalize a literal "/data/config/../evil.json" to
    // "/data/evil.json" before it leaves the client — 404 either way.
    expect((await httpFetch(`${base}/data/config/../evil.json`)).status).toBe(404)
    expect((await httpFetch(`${base}/data/nonsense`)).status).toBe(404)
    // Matches the route regex but no config/package claims that dataFile, and
    // no such file is on disk → 404 from the file-exists check.
    expect((await httpFetch(`${base}/data/config/no-such-config.json`)).status).toBe(404)
  })

  // Both cases below ride on the blob route's no-ref guard: a dataFile no
  // manifest ref claims 404s before any disk access.
  test("sidecar .meta.json is not a public route", async () => {
    // .meta.json holds the cache key + timings, not a blob. The route regex
    // admits "." so nixos.test.meta.json matches — but no ref claims it.
    const res = await httpFetch(`${base}/data/config/nixos.test.meta.json`)
    expect(res.status).toBe(404)
  })

  test("%2F in the config path cannot escape the data dir (LFI)", async () => {
    // The regex admits "%" and matches the STILL-ENCODED pathname (%2F is not
    // "/"); decodeURIComponent then re-introduces "/". Without the no-ref
    // guard, join() would walk out of the data dir and serve any *.json.
    const res = await httpFetch(`${base}/data/config/..%2F..%2Foutside.json`)
    expect(res.status).toBe(404)
  })

  test("GET /data/file/<id> without storePath is a 400", async () => {
    const res = await httpFetch(`${base}/data/file/self:whatever`)
    expect(res.status).toBe(400)
    expect(await res.text()).toBe("storePath required")
  })

  test("GET /data/file/<id> serves an existing storePath with tokens", async () => {
    // The route trusts any absolute path (option declarations point into
    // nixpkgs, not just this flake) — a plain temp file keeps this hermetic.
    // String + comment guarantee tokenizeNix emits at least one run.
    const src = join(dataParent, "on-disk.nix")
    await Bun.write(src, '{ demo = "yes"; } # a comment\n')
    const res = await httpFetch(
      `${base}/data/file/${encodeURIComponent("self:on-disk.nix")}?storePath=${encodeURIComponent(src)}`,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { text: string; tokens: unknown[] }
    expect(body.text).toContain('demo = "yes"')
    expect(body.tokens.length).toBeGreaterThan(0)
  })

  test("stale storePath on a self file is a 404 (nothing to re-fetch from)", async () => {
    const res = await httpFetch(
      `${base}/data/file/${encodeURIComponent("self:gone.nix")}?storePath=/nix/store/nope-source/gone.nix`,
    )
    expect(res.status).toBe(404)
  })

  test("stale storePath on an input file re-fetches through the flake input", async () => {
    await Bun.write(join(shimDir, "input-file.nix"), "{ fromInput = 1; }\n")
    await resetShimLog()
    const res = await httpFetch(
      `${base}/data/file/${encodeURIComponent("input:nixpkgs:lib/mod.nix")}?storePath=/nix/store/nope-source/mod.nix`,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { text: string }
    expect(body.text).toContain("fromInput")
    expect(await shimCounts()).toEqual({ readFile: 1 })
  })

  test("input re-fetch failure surfaces as a 500 with the nix error", async () => {
    await unlink(join(shimDir, "input-file.nix"))
    const res = await httpFetch(
      `${base}/data/file/${encodeURIComponent("input:nixpkgs:lib/other.nix")}?storePath=/nix/store/nope-source/other.nix`,
    )
    expect(res.status).toBe(500)
    expect(await res.text()).toContain("shim input file gone")
  })

  test("a failing extraction marks the config error and the held request 500s", async () => {
    // Back to pending (drop blob + sidecar, refresh), then poison the
    // optionNames eval — the first thing extractOptions runs, so the whole
    // extraction rejects rather than degrading down the ladder.
    await unlink(blobPath())
    await unlink(sidecarPath())
    await httpFetch(`${base}/api/refresh`, { method: "POST" })
    expect((await getManifest()).configurations[0]!.status).toBe("pending")

    await Bun.write(join(shimDir, "fail-optionNames"), "")
    try {
      const res = await httpFetch(`${base}/data/config/nixos.test.json`)
      expect(res.status).toBe(500)
      expect(await res.text()).toContain("optionNames refused")
      const cfg = (await getManifest()).configurations[0]!
      expect(cfg.status).toBe("error")
      expect(cfg.error).toContain("optionNames refused")
    } finally {
      await unlink(join(shimDir, "fail-optionNames"))
    }
  }, 15_000)

  test("the next request retries an errored config and recovers", async () => {
    await resetShimLog()
    const res = await httpFetch(`${base}/data/config/nixos.test.json`)
    expect(res.status).toBe(200)
    expect((await getManifest()).configurations[0]!.status).toBe("ok")
    expect(await shimCounts()).toEqual({ optionNames: 1, options: 1 })
  }, 15_000)

  test("GET /dev/events 404s when the dev flag is off", async () => {
    const res = await httpFetch(`${base}/dev/events`)
    expect(res.status).toBe(404)
  })
})

// The dev server's startup performs this suite's one dev-mode bundle — a
// SECOND Bun.build in the process. buildApp caches per mode, so the process
// stays at two builds total, but two is exactly the count that breaks Bun's
// bundler inside nix's sandboxed test derivation (see build-app.ts). Skip
// there only — detected as NIX_BUILD_TOP with no real nix on PATH (a `nix
// develop` shell sets the var too, but has nix; evaluated at load time,
// before beforeAll prepends the shim dir).
const inNixSandbox = !!process.env.NIX_BUILD_TOP && !Bun.which("nix")

describe.skipIf(inNixSandbox)("serve dev mode (shimmed nix)", () => {
  let devServer: Awaited<ReturnType<typeof serve>>
  let devBase: string

  beforeAll(async () => {
    devServer = await serve(FLAKE_REF, {
      out: dataDir,
      allSystems: false,
      timeout: 60,
      positional: [],
      port: 0,
      dev: true,
    })
    devBase = `http://localhost:${devServer.port}`
  }, 30_000)

  afterAll(() => {
    devServer?.stop(true)
  })

  test("GET / serves the dev page with the auto-reload client", async () => {
    const res = await httpFetch(`${devBase}/`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("/dev/events")
  })

  test("GET /dev/events streams SSE; disconnect unregisters the client", async () => {
    const res = await httpFetch(`${devBase}/dev/events`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const reader = res.body!.getReader()
    const { value } = await reader.read()
    expect(new TextDecoder().decode(value)).toContain(": connected")
    await reader.cancel()
  })
})
