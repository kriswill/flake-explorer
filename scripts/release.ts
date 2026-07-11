// Release plumbing driven by .github/workflows/release.yml (also runnable
// locally). package.json is the single version source — package.nix reads it
// at eval time and the About modal at runtime, so only this file and the
// changelog need editing.
//
//   bun scripts/release.ts bump <major|minor|patch>   edit files, print new version
//   bun scripts/release.ts notes <version>            print a version's changelog section

import { join } from "node:path"

const REPO_URL = "https://github.com/kriswill/flake-explorer"

export type Bump = "major" | "minor" | "patch"

export function bumpVersion(version: string, kind: Bump): string {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!m) throw new Error(`not a plain semver version: ${version}`)
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (kind === "major") return `${major + 1}.0.0`
  if (kind === "minor") return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

/**
 * Move the [Unreleased] content under a new [next] — date heading and refresh
 * the link references (Keep a Changelog layout). Refuses to cut an empty
 * release: [Unreleased] must contain at least one "### " subsection.
 */
export function releaseChangelog(md: string, prev: string, next: string, date: string): string {
  const heading = "## [Unreleased]"
  const at = md.indexOf(heading)
  if (at === -1) throw new Error("CHANGELOG has no [Unreleased] section")
  const rest = md.slice(at + heading.length)
  const sectionEnd = rest.search(/\n## /)
  const section = sectionEnd === -1 ? rest : rest.slice(0, sectionEnd)
  if (!section.includes("### ")) {
    throw new Error("nothing to release: [Unreleased] has no entries")
  }

  const unreleasedLink = `[Unreleased]: ${REPO_URL}/compare/v${prev}...HEAD`
  if (!md.includes(unreleasedLink)) {
    throw new Error(`CHANGELOG link references are stale: expected "${unreleasedLink}"`)
  }

  return md
    .replace(heading, `${heading}\n\n## [${next}] — ${date}`)
    .replace(
      unreleasedLink,
      `[Unreleased]: ${REPO_URL}/compare/v${next}...HEAD\n[${next}]: ${REPO_URL}/compare/v${prev}...v${next}`,
    )
}

/** A released version's section body, for the GitHub release notes. */
export function extractNotes(md: string, version: string): string {
  const m = md.match(new RegExp(`^## \\[${version.replaceAll(".", "\\.")}\\][^\\n]*\\n`, "m"))
  if (!m || m.index === undefined) throw new Error(`CHANGELOG has no [${version}] section`)
  const rest = md.slice(m.index + m[0].length)
  const end = rest.search(/\n## |\n\[[^\]]+\]: http/)
  return (end === -1 ? rest : rest.slice(0, end)).trim()
}

/** CLI body; exported so tests drive it in-process against a fixture root. */
export async function main(args: string[], root?: string): Promise<number> {
  const [cmd, arg] = args
  const dir = root ?? join(import.meta.dir, "..")
  const changelogPath = join(dir, "CHANGELOG.md")
  const pkgPath = join(dir, "package.json")

  if (cmd === "bump" && (arg === "major" || arg === "minor" || arg === "patch")) {
    const pkgText = await Bun.file(pkgPath).text()
    const prev = (JSON.parse(pkgText) as { version: string }).version
    const next = bumpVersion(prev, arg)
    const date = new Date().toISOString().slice(0, 10)
    const changelog = releaseChangelog(await Bun.file(changelogPath).text(), prev, next, date)
    await Bun.write(pkgPath, pkgText.replace(`"version": "${prev}"`, `"version": "${next}"`))
    await Bun.write(changelogPath, changelog)
    console.log(next)
    return 0
  }
  if (cmd === "notes" && arg) {
    console.log(extractNotes(await Bun.file(changelogPath).text(), arg))
    return 0
  }
  console.error("usage: bun scripts/release.ts bump <major|minor|patch> | notes <version>")
  return 1
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
