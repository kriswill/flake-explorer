// The release script edits files unattended in CI — pin its pure logic.

import { describe, expect, test } from "bun:test"
import { bumpVersion, extractNotes, releaseChangelog } from "../scripts/release"

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
