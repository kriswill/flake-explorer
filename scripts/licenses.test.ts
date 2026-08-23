import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { collectAbout } from "./licenses"

describe("collectAbout", () => {
  const about = collectAbout(join(import.meta.dir, ".."))

  test("first-party identity: MIT with copyright and license text", () => {
    expect(about.name).toBe("Flake Explorer")
    expect(about.license).toBe("MIT")
    expect(about.copyright).toContain("Kris Williams")
    expect(about.text).toContain("Permission is hereby granted")
    expect(about.url).toBe("https://github.com/kriswill/flake-explorer")
  })

  test("bundled deps carry their license texts; build tooling excluded", () => {
    const names = about.deps.map((d) => d.name)
    expect(names).toContain("svelte")
    expect(names).not.toContain("bun-plugin-svelte") // BUILD_ONLY
    const svelte = about.deps.find((d) => d.name === "svelte")!
    expect(svelte.license).toBe("MIT")
    expect(svelte.text.length).toBeGreaterThan(200)
  })
})

describe("collectAbout failure modes (synthetic project dir)", () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "about-test-"))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test("a dependency missing from node_modules fails loudly", async () => {
    await Bun.write(join(dir, "package.json"), JSON.stringify({ dependencies: { ghost: "1.0" } }))
    expect(() => collectAbout(dir)).toThrow("cannot locate node_modules/ghost")
  })

  test("a dependency without a shippable license file fails the build", async () => {
    await Bun.write(
      join(dir, "node_modules/ghost/package.json"),
      JSON.stringify({ version: "1.0.0", license: { type: "MIT" } }),
    )
    expect(() => collectAbout(dir)).toThrow("no license file in node_modules/ghost")
  })

  test("a README License section stands in for a missing license file", async () => {
    await Bun.write(
      join(dir, "node_modules/ghost/README.md"),
      "# ghost\n\nDoes things.\n\n## License\n\n(The MIT License)\n\nCopyright (c) 2026 Ghost\n",
    )
    const about = collectAbout(dir)
    expect(about.deps[0]!.text).toBe("(The MIT License)\n\nCopyright (c) 2026 Ghost")
  })

  test("a README without a License section is still a missing notice", async () => {
    await Bun.write(join(dir, "node_modules/ghost/README.md"), "# ghost\n\nDoes things.\n")
    expect(() => collectAbout(dir)).toThrow("no license file in node_modules/ghost")
  })

  test("object-form license and missing first-party LICENSE degrade cleanly", async () => {
    await Bun.write(join(dir, "node_modules/ghost/LICENSE.md"), "Copyright (c) 2026 Ghost")
    const about = collectAbout(dir)
    expect(about.text).toBe(null)
    expect(about.copyright).toBe(null)
    expect(about.url).toBe("https://github.com/kriswill/flake-explorer")
    expect(about.deps).toEqual([
      { name: "ghost", version: "1.0.0", license: "MIT", text: "Copyright (c) 2026 Ghost" },
    ])
  })
})
