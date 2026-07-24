// pageHtml's embedded-data tags: every "<" in a tag body is JSON-unicode-
// escaped so arbitrary values (file sources contain "</script>") can never
// break out of the tag, and serve-mode output keeps exactly the about tag.

import { describe, expect, test } from "bun:test"
import { pageHtml } from "../scripts/build-app"

const bundle = { js: "console.log('</script> < ok')", css: "body{}" }

describe("pageHtml embeds", () => {
  test("values round-trip through the tag with every < escaped", () => {
    const value = { text: "</script><script>alert(1)</script>", n: 1 }
    const html = pageHtml(bundle, "t", {
      embeds: { "file/x%3Ay.nix": value, "manifest.json": { version: 1 } },
    })

    // [^<]* only matches if the body really contains no raw "<".
    const m = html.match(
      /<script type="application\/json" id="data:file\/x%3Ay\.nix">([^<]*)<\/script>/,
    )
    expect(m).not.toBeNull()
    expect(JSON.parse(m![1]!)).toEqual(value)
    expect(html).not.toContain("<script>alert")

    const mm = html.match(
      /<script type="application\/json" id="data:manifest\.json">([^<]*)<\/script>/,
    )
    expect(mm).not.toBeNull()
    expect(JSON.parse(mm![1]!)).toEqual({ version: 1 })

    // The JS bundle's own "</script" stays escaped as before.
    expect(html).toContain("console.log('<\\/script> < ok')")
  })

  test("without embeds the only data tag is about.json (serve mode)", () => {
    const html = pageHtml(bundle, "t")
    const tags = [...html.matchAll(/id="data:([^"]+)"/g)].map((m) => m[1])
    expect(tags).toEqual(["about.json"])
  })
})
