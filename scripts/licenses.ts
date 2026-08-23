// License notices for the About modal (okflight pattern). Bun.build minifies
// svelte's client runtime into the served page and strips copyright headers;
// MIT terms require the notice to accompany every redistributed copy, so the
// page embeds each bundled runtime dependency's LICENSE text alongside
// flake-explorer's own. Collection is driven by package.json `dependencies`
// minus BUILD_ONLY; a dep with no license file falls back to its README's
// License section, and one with neither fails the build.

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

/** Fallback for packages whose tarball ships the notice only as a README
 *  section (fastdom): the verbatim text under a `License` heading, up to the
 *  next heading of the same or higher level. Null when the README has no
 *  such section — that is still a missing notice, not a license to invent. */
function readmeLicenseSection(pkgDir: string): string | null {
  const readme = readdirSync(pkgDir)
    .filter((f) => /^readme([.-]|$)/i.test(f))
    .sort((a, b) => a.length - b.length || a.localeCompare(b))[0]
  if (!readme) return null
  const md = readFileSync(join(pkgDir, readme), "utf8")
  const head = /^(#{1,6})\s*licen[cs]e\b.*\r?\n/im.exec(md)
  if (!head) return null
  const rest = md.slice(head.index + head[0].length)
  const next = rest.search(new RegExp(`^#{1,${head[1].length}}\\s`, "m"))
  const body = (next === -1 ? rest : rest.slice(0, next)).trim()
  return body || null
}

/** One package's license record, located from `from`. The notice comes from
 *  a standalone license file, or failing that the README's License section;
 *  a bundled dep with neither fails the build — its notice must ship with
 *  the copy. */
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
  const text = file ? readFileSync(join(pkgDir, file), "utf8").trim() : readmeLicenseSection(pkgDir)
  if (!text) {
    throw new Error(
      `no license file in node_modules/${name} — its notice must ship with the bundled copy`,
    )
  }
  return {
    name,
    version: meta.version ?? "",
    license: (typeof meta.license === "string" ? meta.license : meta.license?.type) ?? "",
    text,
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
