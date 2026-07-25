#!/usr/bin/env node
// npm launcher: resolve the platform binary package (installed via
// optionalDependencies — npm keeps only the one matching the host) and exec
// it with this package's SPA bundle. The binary itself is dependency-free;
// everything platform-specific lives in the per-target packages.

import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const PLATFORMS = {
  "linux-x64": "@kriswill/flake-explorer-linux-x64",
  "linux-arm64": "@kriswill/flake-explorer-linux-arm64",
  "darwin-arm64": "@kriswill/flake-explorer-darwin-arm64",
}

const key = `${process.platform}-${process.arch}`
const pkg = PLATFORMS[key]
if (!pkg) {
  console.error(`flake-explorer: unsupported platform: ${key}`)
  console.error(`supported: ${Object.keys(PLATFORMS).join(", ")}`)
  process.exit(1)
}

const require = createRequire(import.meta.url)
let bin
try {
  bin = require.resolve(`${pkg}/bin/flake-explorer`)
} catch {
  console.error(`flake-explorer: platform package ${pkg} is not installed.`)
  console.error(
    "It normally arrives via optionalDependencies — reinstall without --no-optional/--omit=optional,",
  )
  console.error(`or add it explicitly: npm install ${pkg}`)
  process.exit(1)
}

// The SPA bundle ships in THIS package (it is platform-independent); the
// binary probes FLAKE_EXPLORER_APP_DIST first, so an explicit user override
// still wins.
const appDist = join(dirname(fileURLToPath(import.meta.url)), "..", "app-dist")

const result = spawnSync(bin, process.argv.slice(2), {
  stdio: "inherit",
  env: {
    FLAKE_EXPLORER_PROG: "flake-explorer",
    FLAKE_EXPLORER_APP_DIST: appDist,
    ...process.env,
  },
})
if (result.error) {
  console.error(`flake-explorer: failed to launch ${bin}: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
