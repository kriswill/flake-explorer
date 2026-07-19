import { describe, expect, test } from "bun:test"
import { colorFor, nameColor, oklchToHex, registerSlotKeys, resetSlotKeys } from "../app/lib/color"

const gen = { l: 0.55, c: 0.13 }

describe("color", () => {
  test("nameColor is deterministic and stable across calls", () => {
    const a = nameColor("modules/darwin/git.nix", gen)
    expect(nameColor("modules/darwin/git.nix", gen)).toBe(a)
    expect(a).toMatch(/^#[0-9a-f]{6}$/)
  })

  test("different keys get different hues (usually)", () => {
    expect(nameColor("aaa", gen)).not.toBe(nameColor("bbb", gen))
  })

  test("oklch conversion clamps to valid sRGB hex", () => {
    for (let h = 0; h < 360; h += 30) {
      expect(oklchToHex(0.6, 0.13, h)).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  test("registered keys map to curated slot vars, overflow generates", () => {
    resetSlotKeys() // another test file's loadManifest may have registered inputs
    registerSlotKeys(Array.from({ length: 14 }, (_, i) => `input-${i}`))
    expect(colorFor("input-0", gen)).toBe("var(--s1)")
    expect(colorFor("input-11", gen)).toBe("var(--s12)")
    expect(colorFor("input-12", gen)).toMatch(/^#[0-9a-f]{6}$/)
    expect(colorFor("never-registered", gen)).toMatch(/^#[0-9a-f]{6}$/)
  })

  test("re-registering is idempotent: keys keep their slot and don't recount", () => {
    // The runtime path for this is a manifest reload (App.svelte's Retry
    // button re-runs loadManifest → registerSlotKeys with the same names).
    resetSlotKeys()
    registerSlotKeys(["a", "b"])
    expect(colorFor("b", gen)).toBe("var(--s2)")
    registerSlotKeys(["b", "c"])
    expect(colorFor("a", gen)).toBe("var(--s1)")
    expect(colorFor("b", gen)).toBe("var(--s2)") // kept, not reassigned
    expect(colorFor("c", gen)).toBe("var(--s3)") // only the new key advances
  })

  test("the 12-slot cap counts distinct keys, not registration calls", () => {
    resetSlotKeys()
    const first = Array.from({ length: 11 }, (_, i) => `k${i}`)
    registerSlotKeys(first)
    registerSlotKeys([...first, "twelfth", "overflow"])
    expect(colorFor("twelfth", gen)).toBe("var(--s12)")
    expect(colorFor("overflow", gen)).toMatch(/^#[0-9a-f]{6}$/)
  })
})
