// Emit the prebuilt SPA bundle for the Rust server (src/page.rs):
// app.js + app.css plus a meta.json carrying the theme/base CSS and About
// data that build-app.ts computes from web/lib at bundle time. The Rust
// binary composes these into the same page HTML the bun server serves.
//
//   bun scripts/bundle-app.ts [--out DIR] [--dev] [--readable]
//
// --readable is for the npm artifact: registries (Socket et al.) flag
// minified code as a quality risk, and the bundle is served from localhost
// anyway, so nothing is gained by shipping it minified.

import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { TEXT_DEFAULT_STEP, textSizeRem } from "../web/lib/type-scale"
import { buildApp, themeCss } from "./build-app"
import { collectAbout } from "./licenses"

const args = process.argv.slice(2)
const outIdx = args.indexOf("--out")
const outDir = outIdx >= 0 ? args[outIdx + 1]! : join(import.meta.dir, "..", "dist", "app")
const dev = args.includes("--dev")
const readable = args.includes("--readable")

// The Svelte plugin needs whitespace minification on even in readable mode
// (see build-app.ts), so the bundle comes out as one long line; biome puts
// the line breaks back. String literals — where Svelte's compiled template
// whitespace lives — are untouched by formatting.
function formatJs(js: string): string {
  const proc = Bun.spawnSync(["bunx", "biome", "format", "--stdin-file-path=app.js"], {
    stdin: Buffer.from(js),
    stdout: "pipe",
    stderr: "pipe",
  })
  if (proc.exitCode !== 0) {
    throw new Error(`biome format failed:\n${proc.stderr.toString()}`)
  }
  return proc.stdout.toString()
}

const bundle = await buildApp(dev, { fresh: true, readable })
mkdirSync(outDir, { recursive: true })
await Bun.write(join(outDir, "app.js"), readable ? formatJs(bundle.js) : bundle.js)
await Bun.write(join(outDir, "app.css"), bundle.css)
await Bun.write(
  join(outDir, "meta.json"),
  JSON.stringify({
    themeCss: themeCss(),
    baseFontRem: textSizeRem(TEXT_DEFAULT_STEP),
    about: collectAbout(join(import.meta.dir, "..")),
  }),
)
console.log(`wrote app bundle to ${outDir} (dev=${dev}, readable=${readable})`)
