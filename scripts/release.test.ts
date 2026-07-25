// The release script edits files unattended in CI — pin its pure logic and
// drive the CLI in-process against a fixture root dir.

import { describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bumpVersion, extractNotes, main, releaseChangelog } from "../scripts/release"

const REPO = "https://github.com/kriswill/flake-explorer"

const CHANGELOG = `# Changelog

## [Unreleased]

### Added

- A new thing.

## [0.1.0] — 2026-07-10

### Added

- Initial release.

[Unreleased]: ${REPO}/compare/v0.1.0...HEAD
[0.1.0]: ${REPO}/releases/tag/v0.1.0
`

describe("bumpVersion", () => {
  test("patch, minor, major", () => {
    expect(bumpVersion("0.1.0", "patch")).toBe("0.1.1")
    expect(bumpVersion("0.1.9", "minor")).toBe("0.2.0")
    expect(bumpVersion("1.2.3", "major")).toBe("2.0.0")
  })

  test("rejects non-semver", () => {
    expect(() => bumpVersion("0.1", "patch")).toThrow("not a plain semver")
    expect(() => bumpVersion("1.0.0-rc.1", "patch")).toThrow("not a plain semver")
  })
})

describe("releaseChangelog", () => {
  test("cuts a release section and refreshes link refs", () => {
    const out = releaseChangelog(CHANGELOG, "0.1.0", "0.2.0", "2026-07-11")
    expect(out).toContain(
      "## [Unreleased]\n\n## [0.2.0] — 2026-07-11\n\n### Added\n\n- A new thing.",
    )
    expect(out).toContain(`[Unreleased]: ${REPO}/compare/v0.2.0...HEAD`)
    expect(out).toContain(`[0.2.0]: ${REPO}/compare/v0.1.0...v0.2.0`)
    expect(out).toContain(`[0.1.0]: ${REPO}/releases/tag/v0.1.0`)
  })

  test("refuses an empty [Unreleased]", () => {
    const empty = CHANGELOG.replace("### Added\n\n- A new thing.\n\n", "")
    expect(() => releaseChangelog(empty, "0.1.0", "0.2.0", "2026-07-11")).toThrow(
      "nothing to release",
    )
  })

  test("refuses stale link references", () => {
    expect(() => releaseChangelog(CHANGELOG, "0.0.9", "0.1.1", "2026-07-11")).toThrow("stale")
  })
})

describe("extractNotes", () => {
  test("returns one version's body", () => {
    expect(extractNotes(CHANGELOG, "0.1.0")).toBe("### Added\n\n- Initial release.")
  })

  test("stops before the link block for the newest section", () => {
    const cut = releaseChangelog(CHANGELOG, "0.1.0", "0.2.0", "2026-07-11")
    expect(extractNotes(cut, "0.2.0")).toBe("### Added\n\n- A new thing.")
  })

  test("throws on unknown version", () => {
    expect(() => extractNotes(CHANGELOG, "3.0.0")).toThrow("no [3.0.0] section")
  })
})

describe("cli (fixture root)", () => {
  function fixtureRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "release-test-"))
    writeFileSync(join(dir, "package.json"), `{\n  "name": "x",\n  "version": "0.1.0"\n}\n`)
    writeFileSync(join(dir, "CHANGELOG.md"), CHANGELOG)
    return dir
  }

  async function run(root: string, ...args: string[]) {
    const out: string[] = []
    const err: string[] = []
    const logSpy = spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")))
    const errSpy = spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")))
    try {
      const exitCode = await main(args, root)
      return { exitCode, stdout: out.join("\n"), stderr: err.join("\n") }
    } finally {
      logSpy.mockRestore()
      errSpy.mockRestore()
    }
  }

  test("bump patch edits both files and prints the version", async () => {
    const root = fixtureRoot()
    const r = await run(root, "bump", "patch")
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe("0.1.1")
    expect(readFileSync(join(root, "package.json"), "utf8")).toContain('"version": "0.1.1"')
    const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8")
    expect(changelog).toContain("## [0.1.1] — ")
    expect(changelog).toContain(`[0.1.1]: ${REPO}/compare/v0.1.0...v0.1.1`)
  })

  test("notes prints a section; bad usage exits 1", async () => {
    const root = fixtureRoot()
    const notes = await run(root, "notes", "0.1.0")
    expect(notes.exitCode).toBe(0)
    expect(notes.stdout).toBe("### Added\n\n- Initial release.")
    const bad = await run(root, "bump", "gigantic")
    expect(bad.exitCode).toBe(1)
    expect(bad.stderr).toContain("usage:")
  })
})
