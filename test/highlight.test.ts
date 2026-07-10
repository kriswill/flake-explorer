import { describe, expect, test } from "bun:test"
import { tokenizeNix } from "../src/extract/highlight"
import type { TokenRun } from "../src/schema"

// tokenizeNix runs the vendored tree-sitter-nix WASM under plain bun — no nix
// or browser needed. These tests pin the run-flattening invariants and the
// UTF-16 offset contract so a vendor regeneration (see highlight.ts header)
// that changes capture behavior gets caught.

/** Assert the core output contract: sorted, non-overlapping, in-bounds runs. */
function expectWellFormed(runs: TokenRun[], text: string) {
  let prevEnd = 0
  for (const r of runs) {
    expect(r.start).toBeGreaterThanOrEqual(prevEnd)
    expect(r.end).toBeGreaterThan(r.start)
    expect(r.end).toBeLessThanOrEqual(text.length)
    prevEnd = r.end
  }
}

/** Find the run whose text slice is exactly `slice`. */
const runFor = (runs: TokenRun[], text: string, slice: string): TokenRun | undefined =>
  runs.find((r) => text.slice(r.start, r.end) === slice)

describe("tokenizeNix", () => {
  test("produces sorted, non-overlapping, in-bounds runs", async () => {
    const text = '{ x = "s"; inherit (builtins) map; # c\n}'
    const runs = await tokenizeNix(text)
    expect(runs.length).toBeGreaterThan(0)
    expectWellFormed(runs, text)
  })

  test("captures strings and comments with the expected names", async () => {
    const text = '{ x = "s"; inherit (builtins) map; # c\n}'
    const runs = await tokenizeNix(text)
    const str = runFor(runs, text, '"s"')
    expect(str).toBeDefined()
    expect(str!.name).toStartWith("string")
    const comment = runFor(runs, text, "# c")
    expect(comment).toBeDefined()
    expect(comment!.name).toStartWith("comment")
  })

  test("offsets stay aligned to JS string indices after multi-byte chars", async () => {
    // 'é' is 1 code unit but 2 UTF-8 bytes; '🎉' is 2 code units / 4 bytes.
    // If offsets were UTF-8 bytes, every run after the comment would drift.
    const text = '# émoji 🎉\nx = "a";'
    const runs = await tokenizeNix(text)
    expectWellFormed(runs, text)
    const comment = runs.find((r) => r.name.startsWith("comment"))
    expect(comment).toBeDefined()
    expect(text.slice(comment!.start, comment!.end)).toBe("# émoji 🎉")
    const str = runFor(runs, text, '"a"')
    expect(str).toBeDefined()
    expect(str!.name).toStartWith("string")
  })

  test("empty input yields no runs", async () => {
    expect(await tokenizeNix("")).toEqual([])
  })
})
