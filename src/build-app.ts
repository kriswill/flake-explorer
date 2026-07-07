// Bundle the Svelte SPA with Bun.build + bun-plugin-svelte (okflight
// pattern). Returns the JS and CSS as strings for the server (or a future
// single-file emitter) to compose into a page.

import { join } from "node:path";
import { SveltePlugin } from "bun-plugin-svelte";
import { THEMES } from "../app/lib/themes";

export interface AppBundle {
  js: string;
  css: string;
}

export async function buildApp(development = false): Promise<AppBundle> {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "..", "app", "main.ts")],
    target: "browser",
    format: "esm",
    minify: !development,
    plugins: [SveltePlugin({ development, compilerOptions: { runes: true } })],
  });
  if (!build.success) {
    throw new Error("app build failed:\n" + build.logs.map(String).join("\n"));
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

export function pageHtml(bundle: AppBundle, title: string): string {
  const esc = (s: string) => s.replace(/<\/script/gi, "<\\/script");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{font-family:system-ui,sans-serif;font-size:14px;background:var(--page);color:var(--ink-1)}
${themeCss()}
${bundle.css.replace(/<\/style/gi, "<\\/style")}
</style>
</head>
<body>
<div id="app"></div>
<script type="module">${esc(bundle.js)}</script>
</body>
</html>`;
}
