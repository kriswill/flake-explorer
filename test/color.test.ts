import { describe, expect, test } from "bun:test";
import { colorFor, nameColor, oklchToHex, registerSlotKeys } from "../app/lib/color";

const gen = { l: 0.55, c: 0.13 };

describe("color", () => {
  test("nameColor is deterministic and stable across calls", () => {
    const a = nameColor("modules/darwin/git.nix", gen);
    expect(nameColor("modules/darwin/git.nix", gen)).toBe(a);
    expect(a).toMatch(/^#[0-9a-f]{6}$/);
  });

  test("different keys get different hues (usually)", () => {
    expect(nameColor("aaa", gen)).not.toBe(nameColor("bbb", gen));
  });

  test("oklch conversion clamps to valid sRGB hex", () => {
    for (let h = 0; h < 360; h += 30) {
      expect(oklchToHex(0.6, 0.13, h)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  test("registered keys map to curated slot vars, overflow generates", () => {
    registerSlotKeys(Array.from({ length: 14 }, (_, i) => `input-${i}`));
    expect(colorFor("input-0", gen)).toBe("var(--s1)");
    expect(colorFor("input-11", gen)).toBe("var(--s12)");
    expect(colorFor("input-12", gen)).toMatch(/^#[0-9a-f]{6}$/);
    expect(colorFor("never-registered", gen)).toMatch(/^#[0-9a-f]{6}$/);
  });
});
