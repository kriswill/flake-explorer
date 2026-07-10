import { describe, expect, test } from "bun:test"
import { THEMES } from "../app/lib/themes"

describe("themes", () => {
  test("all themes define the same var keys (no stale inline vars on toggle)", () => {
    // applyThemeVars only sets properties, never clears — a key present in
    // one theme but missing/typoed in another would leave a stale value.
    const [first, ...rest] = THEMES
    const firstKeys = Object.keys(first!.vars).sort()
    for (const theme of rest) {
      expect(Object.keys(theme.vars).sort()).toEqual(firstKeys)
    }
  })

  test("every theme carries all 12 categorical slots --s1..--s12", () => {
    // color.ts resolves curated slots by name; a missing one breaks colorFor.
    for (const theme of THEMES) {
      for (let i = 1; i <= 12; i++) {
        expect(theme.vars[`--s${i}`]).toBeDefined()
      }
    }
  })

  test("every var value is a 6-digit lowercase hex color", () => {
    for (const theme of THEMES) {
      for (const [k, v] of Object.entries(theme.vars)) {
        expect(v, `${theme.name} ${k}`).toMatch(/^#[0-9a-f]{6}$/)
      }
    }
  })
})
