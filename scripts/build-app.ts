// Bundle the Svelte SPA with Bun.build + bun-plugin-svelte (okflight
// pattern). Returns the JS and CSS as strings for the server (or a future
// single-file emitter) to compose into a page.

import { join } from "node:path"
import { SveltePlugin } from "bun-plugin-svelte"
import { THEMES } from "../app/lib/themes"
import { TEXT_DEFAULT_STEP, textSizeRem, textTokenCss } from "../app/lib/type-scale"
import { type AboutData, collectAbout } from "./licenses"

export interface AppBundle {
  js: string
  css: string
}

// One bundle per mode per process: the sources can't change under a prod
// process, and a second in-process Bun.build deterministically breaks under
// the resource limits of nix's sandboxed test derivation (bogus
// EISDIR/"Unexpected" errors out of svelte/.../disclose-version.js — see
// test/export.test.ts). Serve's dev watcher is the one caller that needs a
// rebuild after source edits; it passes fresh: true, which replaces the
// cached entry.
const bundleCache = new Map<boolean, Promise<AppBundle>>()

export function buildApp(development = false, opts: { fresh?: boolean } = {}): Promise<AppBundle> {
  let bundle = opts.fresh ? undefined : bundleCache.get(development)
  if (!bundle) {
    bundle = buildAppUncached(development)
    bundleCache.set(development, bundle)
    // A failed build must not stick: the next call should retry, not replay
    // the rejection.
    bundle.catch(() => {
      if (bundleCache.get(development) === bundle) bundleCache.delete(development)
    })
  }
  return bundle
}

async function buildAppUncached(development: boolean): Promise<AppBundle> {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "..", "app", "main.ts")],
    target: "browser",
    format: "esm",
    // Whitespace minification stays ON in dev: bun-plugin-svelte derives
    // Svelte's preserveWhitespace from it, and preserved template whitespace
    // leaks visible text nodes into the white-space:pre source views.
    minify: development ? { whitespace: true, syntax: false, identifiers: false } : true,
    plugins: [SveltePlugin({ development, compilerOptions: { runes: true } })],
  })
  if (!build.success) {
    throw new Error(`app build failed:\n${build.logs.map(String).join("\n")}`)
  }
  const entry = build.outputs.find((o) => o.kind === "entry-point")
  if (!entry) throw new Error("app build produced no entry point")
  let css = ""
  for (const o of build.outputs) if (o.path.endsWith(".css")) css += await o.text()
  return { js: await entry.text(), css }
}

/** The default :root blocks are generated from THEMES so they cannot drift. */
export function themeCss(): string {
  const vars = (i: number) =>
    Object.entries(THEMES[i]!.vars)
      .map(([k, v]) => `${k}:${v};`)
      .join("")
  // The --text-* type tokens come from the same module the text-size control
  // steps, so component sizes and the control can never drift apart.
  return `:root{color-scheme:light;${textTokenCss()};${vars(0)}}
@media (prefers-color-scheme: dark){:root{color-scheme:dark;${vars(1)}}}`
}

/**
 * An embedded-data tag loadJson resolves before fetching. Every "<" is
 * JSON-unicode-escaped, so "</script" can never occur in the body no matter
 * what the value contains (file sources include arbitrary Nix text).
 */
function jsonTag(name: string, value: unknown): string {
  const json = JSON.stringify(value).replace(/</g, "\\u003c")
  return `<script type="application/json" id="data:${name}">${json}</script>`
}

export function pageHtml(
  bundle: AppBundle,
  title: string,
  opts: { dev?: boolean; embeds?: Record<string, unknown> } = {},
): string {
  const esc = (s: string) => s.replace(/<\/script/gi, "<\\/script")
  // App identity + bundled-dependency license notices, embedded so the About
  // modal works identically in serve mode and a single-file export (loadJson
  // checks embedded <script> tags before fetching). The exporter adds
  // manifest/config/file documents through the same mechanism; serve must
  // never pass a manifest.json embed — its presence is the client's
  // static-mode signal (see app/lib/data.ts isStatic).
  const about: AboutData = collectAbout(join(import.meta.dir, ".."))
  const dataTags = [
    jsonTag("about.json", about),
    ...Object.entries(opts.embeds ?? {}).map(([name, value]) => jsonTag(name, value)),
  ].join("\n")
  // Dev auto-reload client: an SSE "reload" means the UI bundle was rebuilt;
  // a dropped-then-reestablished connection means the server itself
  // restarted (bun --watch) — reload in both cases.
  const devScript = opts.dev
    ? `<script>(() => {
  let wasConnected = false;
  function connect() {
    const es = new EventSource("/dev/events");
    es.onopen = () => { if (wasConnected) location.reload(); wasConnected = true; };
    es.onmessage = (e) => { if (e.data === "reload") location.reload(); };
    es.onerror = () => { es.close(); setTimeout(connect, 400); };
  }
  connect();
})();</script>`
    : ""
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
*{box-sizing:border-box}
html,body{margin:0;height:100%}
html{font-size:${textSizeRem(TEXT_DEFAULT_STEP)}rem}
body{font-family:system-ui,sans-serif;font-size:var(--text-sm);background:var(--page);color:var(--ink-1)}
${themeCss()}
${bundle.css.replace(/<\/style/gi, "<\\/style")}
</style>
</head>
<body>
<div id="app"></div>
${dataTags}
<script type="module">${esc(bundle.js)}</script>
${devScript}
</body>
</html>`
}
