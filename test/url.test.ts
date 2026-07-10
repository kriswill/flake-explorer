import { describe, expect, test } from "bun:test"
import { commitUrl, webUrl } from "../app/lib/url"

const REV = "0123456789abcdef0123456789abcdef01234567"

describe("webUrl", () => {
  test("passes plain https urls through", () => {
    expect(webUrl("https://github.com/a/b")).toBe("https://github.com/a/b")
  })

  test("strips the git+ scheme prefix", () => {
    expect(webUrl("git+https://example.com/a/b")).toBe("https://example.com/a/b")
  })

  test("rejects non-web schemes even with git+ stripped", () => {
    expect(webUrl("git+ssh://git@github.com/a/b")).toBeNull()
    expect(webUrl("file:///home/k/flake")).toBeNull()
  })

  test("rejects local paths and missing urls", () => {
    expect(webUrl("/local/path")).toBeNull()
    expect(webUrl(undefined)).toBeNull()
    expect(webUrl("")).toBeNull()
  })
})

describe("commitUrl", () => {
  test("github: /commit/<rev>, .git suffix stripped", () => {
    expect(commitUrl("git+https://github.com/a/b.git", REV)).toBe(
      `https://github.com/a/b/commit/${REV}`,
    )
  })

  test("gitlab: /-/commit/<rev>, trailing slash stripped", () => {
    expect(commitUrl("https://gitlab.com/a/b/", REV)).toBe(`https://gitlab.com/a/b/-/commit/${REV}`)
  })

  test("codeberg: same /commit/<rev> shape as github", () => {
    expect(commitUrl("https://codeberg.org/a/b", REV)).toBe(
      `https://codeberg.org/a/b/commit/${REV}`,
    )
  })

  test("unknown host returns null", () => {
    expect(commitUrl("https://git.sr.ht/~a/b", REV)).toBeNull()
  })

  test("missing rev returns null", () => {
    expect(commitUrl("https://github.com/a/b", undefined)).toBeNull()
  })

  test("non-web and unparseable urls return null", () => {
    expect(commitUrl("git+ssh://git@github.com/a/b", REV)).toBeNull()
    expect(commitUrl("https://///", REV)).toBeNull()
    expect(commitUrl(undefined, REV)).toBeNull()
  })
})
