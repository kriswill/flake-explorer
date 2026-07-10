import { describe, expect, test } from "bun:test"
import { importGraph } from "../src/extract/imports"

// importGraph takes read() and idOf() as parameters, so it runs against an
// in-memory fixture map — no nix, no filesystem (mini-flake.test.ts covers
// the real extraction end-to-end, but only when nix is on PATH).
const graph = (files: Record<string, string>) =>
  importGraph(
    Object.keys(files),
    (p) => {
      const text = files[p]
      return text === undefined
        ? Promise.reject(new Error(`no such file: ${p}`))
        : Promise.resolve(text)
    },
    (p) => `id:${p}`,
  )

describe("importGraph", () => {
  test("dedupes repeated imports of the same target", async () => {
    const edges = await graph({
      "a.nix": "import ./lib/c.nix // { extra = import ./lib/c.nix; }",
      "lib/c.nix": "{ }",
    })
    expect(edges).toEqual([{ from: "id:a.nix", to: "id:lib/c.nix" }])
  })

  test("directory imports fall back to default.nix", async () => {
    const edges = await graph({
      "module.nix": "{ imports = [ ./sub ]; }",
      "sub/default.nix": "{ }",
    })
    expect(edges).toEqual([{ from: "id:module.nix", to: "id:sub/default.nix" }])
  })

  test("a file whose read() rejects contributes no edges, siblings still do", async () => {
    const files = {
      "broken.nix": "import ./ok.nix",
      "fine.nix": "import ./ok.nix",
      "ok.nix": "{ }",
    }
    const edges = await importGraph(
      Object.keys(files),
      (p) =>
        p === "broken.nix"
          ? Promise.reject(new Error("boom"))
          : Promise.resolve(files[p as keyof typeof files]),
      (p) => `id:${p}`,
    )
    expect(edges).toEqual([{ from: "id:fine.nix", to: "id:ok.nix" }])
  })

  test("references to unknown paths produce no edge", async () => {
    const edges = await graph({
      "a.nix": "import ./nonexistent.nix",
    })
    expect(edges).toEqual([])
  })

  test("references escaping the root produce no edge", async () => {
    const edges = await graph({
      "a.nix": "import ../../outside.nix",
      "outside.nix": "{ }",
    })
    expect(edges).toEqual([])
  })

  test("self-imports are excluded", async () => {
    const edges = await graph({
      "dir/a.nix": "import ./a.nix",
    })
    expect(edges).toEqual([])
  })
})
