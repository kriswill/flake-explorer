// Persisted UI preferences (theme, text scale, pane widths) — localStorage-
// backed chrome state, split out of AppState (state.svelte.ts) so the
// data/routing state machine and the appearance knobs evolve independently.
// Components that only tweak appearance import `prefs`, not `app`.

import { applyThemeVars, defaultThemeIndex, THEMES } from "./themes"
import { clampTextStep, TEXT_DEFAULT_STEP, textSizeRem, textStepName } from "./type-scale"

// The stored value is a step INDEX on the type scale, not the old 0.5–1.5
// multiplier — hence the key bump. A stale "1.1" read as a step would round
// to 1 ("XS"), so @2 values must not be inherited; everyone starts at the
// new default, which is the point of changing it.
const TEXT_STEP_KEY = "flake-explorer:text-step@3"

const THEME_KEY = "flake-explorer:theme@1"

const PANE_KEY = "flake-explorer:panes@1"
const PANE_DEFAULTS = { left: 280, right: 340 }
const PANE_LIMITS = {
  left: { min: 160, max: 640 },
  right: { min: 200, max: 720 },
} as const

class Prefs {
  themeIndex = $state(0)
  /** Step on the type scale; all component type is rem-based, so the root font-size moves everything. */
  textStep = $state(TEXT_DEFAULT_STEP)
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

  // --------------------------------------------------------------- text size

  /** The current step's name ("M"), which the control shows in place of a percentage. */
  get textSizeName(): string {
    return textStepName(this.textStep)
  }

  initTextSize() {
    if (typeof localStorage === "undefined") return
    // getItem returns null when unset and Number(null) is 0 — a REAL step
    // ("XXS"), so an absent value must be caught before the numeric check.
    const raw = localStorage.getItem(TEXT_STEP_KEY)
    this.setTextStep(raw === null ? TEXT_DEFAULT_STEP : Number(raw))
  }

  setTextStep(step: number) {
    this.textStep = clampTextStep(step)
    if (typeof localStorage !== "undefined")
      localStorage.setItem(TEXT_STEP_KEY, String(this.textStep))
    if (typeof document !== "undefined") {
      // The default already sits in the page shell's static CSS, so clear the
      // inline override rather than restating it — that keeps the default
      // rendering correct before (and without) JS, with no size flash.
      document.documentElement.style.fontSize =
        this.textStep === TEXT_DEFAULT_STEP ? "" : `${textSizeRem(this.textStep)}rem`
    }
  }

  adjustTextStep(delta: number) {
    this.setTextStep(this.textStep + delta)
  }

  resetTextSize() {
    this.setTextStep(TEXT_DEFAULT_STEP)
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
