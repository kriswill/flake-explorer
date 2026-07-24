// Stage the npm packages into dist-npm/: one platform package per compiled
// binary, plus the main package (launcher + SPA bundle) whose
// optionalDependencies pin the platform packages at the same version.
//
// The repo's own package.json deliberately does NOT carry those
// optionalDependencies — they only exist on npm after a release, and listing
// them in the dev workspace would break `bun install --frozen-lockfile`.
// This script builds the publishable layout instead:
//
//   bun scripts/build-npm.ts --binary target/x86_64-unknown-linux-musl/release/flake-explorer --target linux-x64
//   bun scripts/build-npm.ts --binary ... --target darwin-arm64
//   bun scripts/build-npm.ts --main            # launcher + app-dist + rewritten package.json
//
// Then: for d in dist-npm/*; do (cd $d && npm publish --provenance --access public); done
// (platform packages first, main last — npm resolves optionalDependencies at
// install time, not publish time, but publishing main first would leave a
// window where installs miss their binary).

import { chmodSync, cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")
const OUT = join(ROOT, "dist-npm")
const TARGETS = ["linux-x64", "linux-arm64", "darwin-arm64"] as const
type Target = (typeof TARGETS)[number]

const rootPkg = (await Bun.file(join(ROOT, "package.json")).json()) as {
  name: string
  version: string
  description: string
  license: string
  homepage?: string
  repository?: unknown
  keywords?: string[]
}

const platformName = (t: Target) => `${rootPkg.name}-${t}`

function parseArgs(argv: string[]) {
  const opts: { binary?: string; target?: Target; main?: boolean } = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--binary") opts.binary = argv[++i]
    else if (argv[i] === "--target") opts.target = argv[++i] as Target
    else if (argv[i] === "--main") opts.main = true
    else throw new Error(`unknown arg: ${argv[i]}`)
  }
  return opts
}

function stagePlatform(binary: string, target: Target) {
  if (!TARGETS.includes(target)) throw new Error(`unknown target: ${target}`)
  if (!existsSync(binary)) throw new Error(`binary not found: ${binary}`)
  const [os, cpu] = target.split("-") as [string, string]
  const dir = join(OUT, `flake-explorer-${target}`)
  mkdirSync(join(dir, "bin"), { recursive: true })
  cpSync(binary, join(dir, "bin", "flake-explorer"))
  chmodSync(join(dir, "bin", "flake-explorer"), 0o755)
  cpSync(join(ROOT, "LICENSE"), join(dir, "LICENSE"))
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: platformName(target),
        version: rootPkg.version,
        description: `${target} binary for flake-explorer`,
        license: rootPkg.license,
        repository: rootPkg.repository,
        homepage: rootPkg.homepage,
        os: [os],
        cpu: [cpu],
        files: ["bin/"],
      },
      null,
      2,
    )}\n`,
  )
  console.log(`staged ${dir}`)
}

async function stageMain() {
  const appDist = join(ROOT, "app-dist")
  if (!existsSync(join(appDist, "app.js"))) {
    throw new Error("app-dist/ missing — run `bun scripts/bundle-app.ts` first")
  }
  const dir = join(OUT, "flake-explorer")
  mkdirSync(dir, { recursive: true })
  cpSync(join(ROOT, "bin"), join(dir, "bin"), { recursive: true })
  cpSync(appDist, join(dir, "app-dist"), { recursive: true })
  cpSync(join(ROOT, "LICENSE"), join(dir, "LICENSE"))
  cpSync(join(ROOT, "README.md"), join(dir, "README.md"))
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: rootPkg.name,
        version: rootPkg.version,
        description: rootPkg.description,
        license: rootPkg.license,
        repository: rootPkg.repository,
        homepage: rootPkg.homepage,
        keywords: rootPkg.keywords,
        publishConfig: { access: "public" },
        bin: { "flake-explorer": "bin/flake-explorer.mjs" },
        files: ["bin/", "app-dist/"],
        engines: { node: ">=20" },
        optionalDependencies: Object.fromEntries(
          TARGETS.map((t) => [platformName(t), rootPkg.version]),
        ),
      },
      null,
      2,
    )}\n`,
  )
  console.log(`staged ${dir}`)
}

const opts = parseArgs(process.argv.slice(2))
if (opts.main) {
  await stageMain()
} else if (opts.binary && opts.target) {
  stagePlatform(opts.binary, opts.target)
} else {
  throw new Error("usage: build-npm.ts --binary PATH --target T | --main")
}
