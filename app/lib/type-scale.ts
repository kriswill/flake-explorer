// The app's type scale — shared by the client (the A−/A+ control in
// prefs.svelte.ts) and the server (the page shell's static CSS in
// src/build-app.ts), so the default size can't drift between them.
//
// Steps are a modular scale: each one multiplies by a fixed ratio rather
// than adding a fixed amount, so the type keeps its proportions at every
// size. Linear nudges (the old ±10 percentage points) don't — the same
// +0.1 is a 10% jump at the bottom of the range and a 7% jump at the top.
//
// Sizes are rem, never px. On the ROOT element `rem` resolves against the
// property's initial value — the browser's own default font size — so a
// reader who set 20px in their browser keeps that as the baseline and the
// scale multiplies from there. A hard px root silently overrides them.

/** Major second — the conventional ratio for dense UI type. */
export const TEXT_RATIO = 1.125

/** Step names, smallest → largest. The index into this list IS the stored value. */
export const TEXT_STEPS = ["XXS", "XS", "S", "M", "L", "XL", "XXL"] as const

/** "M" — the default reading size, and the midpoint of the range. */
export const TEXT_DEFAULT_STEP = 3

/**
 * Root size at the default step, as a multiple of the browser's default:
 * 1.12 × 16px = 17.92px, the previous 22.4px base reduced by 20%.
 */
const TEXT_BASE_REM = 1.12

/** Clamp to a real step index; anything out of range or non-numeric → default. */
export function clampTextStep(step: number): number {
  if (!Number.isFinite(step)) return TEXT_DEFAULT_STEP
  return Math.min(TEXT_STEPS.length - 1, Math.max(0, Math.round(step)))
}

/** Root font-size for a step, in rem (3dp — CSS needs no more precision). */
export function textSizeRem(step: number): number {
  const exp = clampTextStep(step) - TEXT_DEFAULT_STEP
  return Math.round(TEXT_BASE_REM * TEXT_RATIO ** exp * 1000) / 1000
}

/** Display name for a step, e.g. "M" — what the control shows instead of a %. */
export function textStepName(step: number): string {
  return TEXT_STEPS[clampTextStep(step)]!
}

/**
 * Component type tokens — the same ratio, keyed by how many steps below the
 * root each one sits. Components say `font-size: var(--text-xs)` instead of a
 * raw number, so every size in the app lands on the scale by construction
 * rather than by whoever last eyeballed a pixel value.
 *
 * Six steps covers the whole UI: micro badges (3xs) through the largest
 * heading (lg). Sizes that used to sit between steps were drift, not
 * hierarchy — no two of them were ever visible in the same component.
 */
export const TEXT_TOKENS = {
  "3xs": -4,
  "2xs": -3,
  xs: -2,
  sm: -1,
  md: 0,
  lg: 1,
} as const

/** Size of one component token, in rem relative to the root. */
export function tokenRem(step: number): number {
  return Math.round(TEXT_RATIO ** step * 1000) / 1000
}

/** The `--text-*` declarations for the page shell's `:root` block. */
export function textTokenCss(): string {
  return Object.entries(TEXT_TOKENS)
    .map(([name, step]) => `--text-${name}:${tokenRem(step)}rem`)
    .join(";")
}
