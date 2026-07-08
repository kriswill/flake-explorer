// Theme stops: light and dark (okflight's warm paper palette). Each stop is
// a complete CSS custom-property set applied inline on :root — inline wins
// over the prefers-color-scheme defaults in the shell, so a chosen theme
// overrides the OS scheme.
//
// The 12 categorical slots (--s1..--s12) are CVD-validated (Machado
// protan/deutan ΔE ≥ 15 worst pair) per surface; `gen` feeds color.ts for
// keys beyond the curated slots.

import type { GenParams } from "./color";

export interface ThemeDef {
  name: string;
  vars: Record<string, string>;
  gen: GenParams;
}

export const THEMES: ThemeDef[] = [
  {
    name: "light",
    gen: { l: 0.55, c: 0.13 },
    vars: {
      "--surface-1": "#faf9f4", "--page": "#f3f2ec",
      "--ink-1": "#0b0b0b", "--ink-2": "#52514e", "--ink-muted": "#898781",
      "--grid": "#ddddd3", "--baseline": "#c0bfb2",
      "--link": "#256abf",
      "--ok": "#0b7a4e", "--warn": "#9a5b00", "--err": "#b3392f",
      "--s1": "#4478bc", "--s2": "#009766", "--s3": "#d38f00", "--s4": "#056b00",
      "--s5": "#5041ae", "--s6": "#c54b46", "--s7": "#e9709e", "--s8": "#e66e41",
      "--s9": "#2fbbb9", "--s10": "#51abd7", "--s11": "#87b46f", "--s12": "#6c4686",
      // Code-syntax roles: same hues as their --sN counterparts, darkened so
      // small text clears ~4.5:1 against the light page (the --sN values
      // themselves stay put — they're shared with the CVD-tuned category dots).
      "--code-keyword": "#5041ae", "--code-string": "#007e4f", "--code-number": "#9f5e00",
      "--code-function": "#3b6fb2", "--code-builtin": "#be4540", "--code-property": "#007a79",
      "--code-json-string": "#bc4816",
    },
  },
  {
    name: "dark",
    gen: { l: 0.6, c: 0.13 },
    vars: {
      "--surface-1": "#1a1a19", "--page": "#0d0d0d",
      "--ink-1": "#ffffff", "--ink-2": "#c3c2b7", "--ink-muted": "#898781",
      "--grid": "#2c2c2a", "--baseline": "#383835",
      "--link": "#6da7ec",
      "--ok": "#2fbe8b", "--warn": "#d99a1f", "--err": "#e06c5f",
      "--s1": "#1481f3", "--s2": "#46a87f", "--s3": "#c68413", "--s4": "#007600",
      "--s5": "#857dd3", "--s6": "#ad4b4b", "--s7": "#b31d60", "--s8": "#cb5e36",
      "--s9": "#16a295", "--s10": "#359eba", "--s11": "#81a05a", "--s12": "#77569b",
      // Dark theme's --sN text already reads fine against the near-black page —
      // code-* just mirrors the roles it uses.
      "--code-keyword": "#857dd3", "--code-string": "#46a87f", "--code-number": "#c68413",
      "--code-function": "#1481f3", "--code-builtin": "#ad4b4b", "--code-property": "#16a295",
      "--code-json-string": "#cb5e36",
    },
  },
];

/** Index the toggle rests at when the user hasn't picked a theme. */
export const defaultThemeIndex = (dark: boolean) => (dark ? 1 : 0);

export function applyThemeVars(i: number) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(THEMES[i]!.vars)) root.style.setProperty(k, v);
  root.style.setProperty("color-scheme", THEMES[i]!.name);
}
