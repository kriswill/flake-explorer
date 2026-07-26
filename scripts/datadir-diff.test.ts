// The fidelity check has to fail for the right reasons and pass for the right
// reasons: a normalizer that is too generous turns an A/B into a rubber stamp.
// Every case here is a data dir built in a temp directory — no nix, no runs.

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { canonical, compareDirs, fileList, firstDelta, main, normalize } from "./datadir-diff"

/** A minimal data dir: a manifest, one sidecar, one blob. */
function dataDir(over: {
  generatedAt?: string
  extractedAt?: string
  durationMs?: number
  extractor?: string
  optionLoc?: string
  extraFile?: boolean
}): string {
  const dir = mkdtempSync(join(tmpdir(), "datadir-"))
  mkdirSync(join(dir, "config"))
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      generatedAt: over.generatedAt ?? "2026-07-26T00:00:00.000Z",
      extractor: over.extractor ?? "rs-aaaaaaaaaaaaaa",
      configurations: [
        {
          id: "nixos/mini",
          extractedAt: over.extractedAt ?? "2026-07-26T00:00:01.000Z",
          durationMs: over.durationMs ?? 100,
        },
      ],
    }),
  )
  writeFileSync(
    join(dir, "config", "nixos.mini.meta.json"),
    JSON.stringify({
      extractor: over.extractor ?? "rs-aaaaaaaaaaaaaa",
      extractedAt: over.extractedAt ?? "2026-07-26T00:00:01.000Z",
      durationMs: over.durationMs ?? 100,
    }),
  )
  writeFileSync(
    join(dir, "config", "nixos.mini.json"),
    JSON.stringify({ options: [{ loc: over.optionLoc ?? "services.nginx.enable" }] }),
  )
  if (over.extraFile) writeFileSync(join(dir, "config", "stray.json"), "{}")
  return dir
}

describe("normalize", () => {
  test("folds the per-run fields at any depth, keeping everything else", () => {
    const out = normalize({
      keep: 1,
      generatedAt: "t",
      nested: [{ durationMs: 5, extractedAt: "t", other: "x" }],
    }) as Record<string, unknown>
    expect(out.keep).toBe(1)
    expect(out.generatedAt).toBe("<varies per run>")
    expect((out.nested as Record<string, unknown>[])[0]).toEqual({
      durationMs: "<varies per run>",
      extractedAt: "<varies per run>",
      other: "x",
    })
  })

  test("leaves the fingerprint alone unless asked", () => {
    const strict = normalize({ extractor: "rs-1" }) as Record<string, unknown>
    const cross = normalize({ extractor: "rs-1" }, { crossArm: true }) as Record<string, unknown>
    expect(strict.extractor).toBe("rs-1")
    expect(cross.extractor).toBe("<per build>")
  })

  test("replaces rather than deletes, so a vanished field still differs", () => {
    const withField = canonical(JSON.stringify({ a: 1, durationMs: 5 }))
    const without = canonical(JSON.stringify({ a: 1 }))
    expect(withField).not.toBe(without)
  })

  test("key order is not a difference", () => {
    expect(canonical('{"b":1,"a":2}')).toBe(canonical('{"a":2,"b":1}'))
  })
})

describe("compareDirs", () => {
  test("two runs of one binary are identical", () => {
    const a = dataDir({})
    const b = dataDir({
      generatedAt: "2026-07-26T09:09:09.000Z",
      extractedAt: "2026-07-26T09:09:10.000Z",
      durationMs: 999,
    })
    expect(compareDirs(a, b)).toEqual([])
  })

  test("a moved blob byte is a finding", () => {
    const a = dataDir({})
    const b = dataDir({ optionLoc: "services.nginx.enabled" })
    const found = compareDirs(a, b)
    expect(found).toHaveLength(1)
    expect(found[0].path).toBe(join("config", "nixos.mini.json"))
    expect(found[0].detail).toContain("services.nginx.enable")
  })

  test("a changed fingerprint fails strictly and passes cross-arm", () => {
    const a = dataDir({})
    const b = dataDir({ extractor: "rs-bbbbbbbbbbbbbb" })
    expect(compareDirs(a, b).length).toBe(2) // manifest + sidecar
    expect(compareDirs(a, b, { crossArm: true })).toEqual([])
  })

  test("an extra or missing file is a finding, not silence", () => {
    const a = dataDir({})
    const b = dataDir({ extraFile: true })
    expect(compareDirs(a, b).map((f) => f.kind)).toEqual(["added"])
    expect(compareDirs(b, a).map((f) => f.kind)).toEqual(["missing"])
  })
})

describe("fileList", () => {
  test("walks nested directories, relative and sorted", () => {
    const list = fileList(dataDir({}))
    expect(list).toEqual([
      join("config", "nixos.mini.json"),
      join("config", "nixos.mini.meta.json"),
      "manifest.json",
    ])
  })
})

describe("firstDelta", () => {
  test("names the line and both sides", () => {
    expect(firstDelta("a\nb\nc", "a\nX\nc")).toBe('line 2: "b" vs "X"')
  })

  test("reports the short side as eof", () => {
    expect(firstDelta("a\nb", "a")).toContain("<eof>")
  })
})

describe("main", () => {
  test("0 when identical, 1 when not, 2 on a usage error", () => {
    const a = dataDir({})
    const b = dataDir({ optionLoc: "other" })
    expect(main([a, a])).toBe(0)
    expect(main([a, b])).toBe(1)
    expect(main([a])).toBe(2)
  })
})

describe("non-JSON files", () => {
  test("are compared as bytes, since nothing can be normalized out of them", () => {
    const a = dataDir({})
    const b = dataDir({})
    writeFileSync(join(a, "notes.txt"), "one")
    writeFileSync(join(b, "notes.txt"), "two")
    const found = compareDirs(a, b)
    expect(found).toEqual([{ path: "notes.txt", kind: "content", detail: "bytes differ" }])
  })
})
