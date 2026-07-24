// Emit the prebuilt SPA bundle for the Rust server (rust/src/page.rs):
// app.js + app.css plus a meta.json carrying the theme/base CSS and About
// data that build-app.ts computes from app/lib at bundle time. The Rust
// binary composes these into the same page HTML the bun server serves.
//
//   bun scripts/bundle-app.ts [--out DIR] [--dev]

import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { TEXT_DEFAULT_STEP, textSizeRem } from "../app/lib/type-scale"
import { buildApp, themeCss } from "./build-app"
import { collectAbout } from "./licenses"

const args = process.argv.slice(2)
const outIdx = args.indexOf("--out")
const outDir = outIdx >= 0 ? args[outIdx + 1]! : join(import.meta.dir, "..", "app-dist")
const dev = args.includes("--dev")

const bundle = await buildApp(dev, { fresh: true })
mkdirSync(outDir, { recursive: true })
await Bun.write(join(outDir, "app.js"), bundle.js)
await Bun.write(join(outDir, "app.css"), bundle.css)
await Bun.write(
  join(outDir, "meta.json"),
  JSON.stringify({
    themeCss: themeCss(),
    baseFontRem: textSizeRem(TEXT_DEFAULT_STEP),
    about: collectAbout(join(import.meta.dir, "..")),
  }),
)
console.log(`wrote app bundle to ${outDir} (dev=${dev})`)
