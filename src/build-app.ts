// Bundle the Svelte SPA with Bun.build + bun-plugin-svelte (okflight
// pattern). Returns the JS and CSS as strings for the server (or a future
// single-file emitter) to compose into a page.

import { join } from "node:path";
import { SveltePlugin } from "bun-plugin-svelte";
import { THEMES } from "../app/lib/themes";
import { type AboutData, collectAbout } from "./licenses";

export interface AppBundle {
  js: string;
  css: string;
}

export async function buildApp(development = false): Promise<AppBundle> {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "..", "app", "main.ts")],
    target: "browser",
    format: "esm",
    // Whitespace minification stays ON in dev: bun-plugin-svelte derives
    // Svelte's preserveWhitespace from it, and preserved template whitespace
    // leaks visible text nodes into the white-space:pre source views.
    minify: development ? { whitespace: true, syntax: false, identifiers: false } : true,
    plugins: [SveltePlugin({ development, compilerOptions: { runes: true } })],
  });
  if (!build.success) {
    throw new Error(`app build failed:\n${build.logs.map(String).join("\n")}`);
  }
  const entry = build.outputs.find((o) => o.kind === "entry-point");
  if (!entry) throw new Error("app build produced no entry point");
  let css = "";
  for (const o of build.outputs) if (o.path.endsWith(".css")) css += await o.text();
  return { js: await entry.text(), css };
}

/** The default :root blocks are generated from THEMES so they cannot drift. */
function themeCss(): string {
  const vars = (i: number) =>
    Object.entries(THEMES[i]!.vars)
      .map(([k, v]) => `${k}:${v};`)
      .join("");
  return `:root{color-scheme:light;${vars(0)}}
@media (prefers-color-scheme: dark){:root{color-scheme:dark;${vars(1)}}}`;
}

export function pageHtml(bundle: AppBundle, title: string, opts: { dev?: boolean } = {}): string {
  const esc = (s: string) => s.replace(/<\/script/gi, "<\\/script");
  // App identity + bundled-dependency license notices, embedded so the
  // About modal works identically in serve mode and a future single-file
  // build (loadJson checks embedded <script> tags before fetching).
  const about: AboutData = collectAbout(join(import.meta.dir, ".."));
  const aboutJson = JSON.stringify(about).replace(/</g, "\\u003c");
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
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{font-family:system-ui,sans-serif;font-size:0.875rem;background:var(--page);color:var(--ink-1)}
${themeCss()}
${bundle.css.replace(/<\/style/gi, "<\\/style")}
</style>
</head>
<body>
<div id="app"></div>
<script type="application/json" id="data:about.json">${aboutJson}</script>
<script type="module">${esc(bundle.js)}</script>
${devScript}
</body>
</html>`;
}
