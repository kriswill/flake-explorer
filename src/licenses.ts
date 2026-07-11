// License notices for the About modal (okflight pattern). Bun.build minifies
// svelte's client runtime into the served page and strips copyright headers;
// MIT terms require the notice to accompany every redistributed copy, so the
// page embeds each bundled runtime dependency's LICENSE text alongside
// flake-explorer's own. Collection is driven by package.json `dependencies`
// minus BUILD_ONLY, and a dep with no findable license file fails the build.

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

export interface DepLicense {
  name: string
  version: string
  license: string
  text: string
}

export interface AboutData {
  name: string
  version: string
  url: string
  license: string
  copyright: string | null
  /** First-party LICENSE text (null if the file is missing in a trimmed copy). */
  text: string | null
  deps: DepLicense[]
}

/** `dependencies` whose code is NOT bundled into the page: the Svelte build
 *  plugin runs at CLI time only, so embedding its notice would misstate what
 *  the page contains. Dev/test tooling stays in devDependencies. */
export const BUILD_ONLY = new Set(["bun-plugin-svelte"])

/** Walk the node_modules chain up from `from` (nested in a checkout / nix
 *  package, flat for npm installs; symlink stores resolve via existsSync). */
export function packageDir(name: string, from: string): string {
  let dir = from
  for (;;) {
    const cand = join(dir, "node_modules", name)
    if (existsSync(cand)) return cand
    const parent = dirname(dir)
    if (parent === dir) {
      throw new Error(
        `cannot locate node_modules/${name} from ${from} — are dependencies installed?`,
      )
    }
    dir = parent
  }
}

/** One package's license record, located from `from`. A bundled dep with no
 *  findable license file fails the build — its notice must ship with the copy. */
export function readDepLicense(name: string, from: string): DepLicense {
  const pkgDir = packageDir(name, from)
  const meta = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
    version?: string
    license?: string | { type?: string }
  }
  // LICENSE / LICENSE.md / LICENCE / license.txt, any case; shortest wins.
  const file = readdirSync(pkgDir)
    .filter((f) => /^licen[cs]e([.-]|$)/i.test(f))
    .sort((a, b) => a.length - b.length || a.localeCompare(b))[0]
  if (!file) {
    throw new Error(
      `no license file in node_modules/${name} — its notice must ship with the bundled copy`,
    )
  }
  return {
    name,
    version: meta.version ?? "",
    license: (typeof meta.license === "string" ? meta.license : meta.license?.type) ?? "",
    text: readFileSync(join(pkgDir, file), "utf8").trim(),
  }
}

/** Everything the About modal needs, read from the project root `dir`. */
export function collectAbout(dir: string): AboutData {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    version?: string
    license?: string
    homepage?: string
    dependencies?: Record<string, string>
  }

  const licPath = join(dir, "LICENSE")
  const text = existsSync(licPath) ? readFileSync(licPath, "utf8").trim() : null
  const copyright = text?.match(/^Copyright .+$/m)?.[0].replace(/^Copyright \(c\)/i, "©") ?? null

  const deps = Object.keys(pkg.dependencies ?? {})
    .filter((name) => !BUILD_ONLY.has(name))
    .sort()
    .map((name) => readDepLicense(name, dir))

  return {
    name: "Flake Explorer",
    version: pkg.version ?? "",
    url: (pkg.homepage ?? "https://github.com/kriswill/flake-explorer").replace(/#.*$/, ""),
    license: pkg.license ?? "",
    copyright,
    text,
    deps,
  }
}
