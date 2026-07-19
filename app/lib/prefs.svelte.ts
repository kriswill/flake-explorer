// Persisted UI preferences (theme, text scale, pane widths) — localStorage-
// backed chrome state, split out of AppState (state.svelte.ts) so the
// data/routing state machine and the appearance knobs evolve independently.
// Components that only tweak appearance import `prefs`, not `app`.

import { applyThemeVars, defaultThemeIndex, THEMES } from "./themes"

// Baseline root font-size at 100%. 22.4px = the old 16px base at 140%,
// rebased so the comfortable reading size reads as "100%". The storage key
// is versioned: values saved against the 16px base would render wrong.
const FONT_BASE_PX = 22.4
const FONT_SCALE_KEY = "flake-explorer:font-scale@2"
const FONT_SCALE_MIN = 0.5
const FONT_SCALE_MAX = 1.5

const THEME_KEY = "flake-explorer:theme@1"

const PANE_KEY = "flake-explorer:panes@1"
const PANE_DEFAULTS = { left: 280, right: 340 }
const PANE_LIMITS = {
  left: { min: 160, max: 640 },
  right: { min: 200, max: 720 },
} as const

class Prefs {
  themeIndex = $state(0)
  /** Text scale factor; all component type is rem-based, so root font-size scales everything. */
  fontScale = $state(1)
  paneLeft = $state(PANE_DEFAULTS.left)
  paneRight = $state(PANE_DEFAULTS.right)

  // ------------------------------------------------------------------ theme

  /** Restore the saved theme; fall back to the OS preference on first visit. */
  initTheme(prefersDark: boolean) {
    const saved = typeof localStorage === "undefined" ? null : localStorage.getItem(THEME_KEY)
    const i = saved === null ? Number.NaN : Number(saved)
    this.setTheme(
      Number.isInteger(i) && i >= 0 && i < THEMES.length ? i : defaultThemeIndex(prefersDark),
    )
  }

  /** Single write path for the theme: state + persisted choice + CSS vars stay in sync. */
  setTheme(i: number) {
    if (!THEMES[i]) return
    this.themeIndex = i
    if (typeof localStorage !== "undefined") localStorage.setItem(THEME_KEY, String(i))
    applyThemeVars(i)
  }

  // ------------------------------------------------------------- font scale

  initFontScale() {
    if (typeof localStorage === "undefined") return
    const saved = Number(localStorage.getItem(FONT_SCALE_KEY))
    this.setFontScale(Number.isFinite(saved) && saved > 0 ? saved : 1)
  }

  setFontScale(scale: number) {
    this.fontScale =
      Math.round(Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, scale)) * 100) / 100
    if (typeof localStorage !== "undefined")
      localStorage.setItem(FONT_SCALE_KEY, String(this.fontScale))
    if (typeof document !== "undefined") {
      document.documentElement.style.fontSize = `${FONT_BASE_PX * this.fontScale}px`
    }
  }

  adjustFontScale(delta: number) {
    this.setFontScale(this.fontScale + delta)
  }

  // ------------------------------------------------------------ pane widths

  initPanes() {
    if (typeof localStorage === "undefined") return
    try {
      const saved = JSON.parse(localStorage.getItem(PANE_KEY) ?? "{}") as {
        left?: number
        right?: number
      }
      if (Number.isFinite(saved.left)) this.setPane("left", saved.left!)
      if (Number.isFinite(saved.right)) this.setPane("right", saved.right!)
    } catch {
      // corrupt value — keep defaults
    }
  }

  setPane(side: "left" | "right", px: number) {
    const { min, max } = PANE_LIMITS[side]
    const clamped = Math.round(Math.min(max, Math.max(min, px)))
    if (side === "left") this.paneLeft = clamped
    else this.paneRight = clamped
  }

  /** Called at drag end / after keyboard resize — not per pointermove. */
  savePanes() {
    if (typeof localStorage === "undefined") return
    localStorage.setItem(PANE_KEY, JSON.stringify({ left: this.paneLeft, right: this.paneRight }))
  }

  resetPanes() {
    this.paneLeft = PANE_DEFAULTS.left
    this.paneRight = PANE_DEFAULTS.right
    this.savePanes()
  }
}

export const prefs = new Prefs()
