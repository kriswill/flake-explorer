import { describe, expect, test } from "bun:test"
import { extractorFingerprint } from "../src/extract/fingerprint"

describe("extractorFingerprint", () => {
  test("yields a stable 16-hex-char hash of the extraction code", async () => {
    const fp = await extractorFingerprint()
    expect(fp).toMatch(/^[0-9a-f]{16}$/)
    // Memoized: repeated calls agree (and cost nothing).
    expect(await extractorFingerprint()).toBe(fp)
  })
})
