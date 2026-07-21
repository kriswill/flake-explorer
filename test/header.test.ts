// Header.svelte: the text-size control (icon buttons stepping the type
// scale), the theme toggle, and the wordmark/about actions. The prefs
// plumbing itself is covered in app.test.ts — this covers the chrome that
// drives it, which nothing mounted before.

import { beforeEach, describe, expect, test } from "bun:test"
import { flushSync } from "svelte"
import Header from "../app/components/Header.svelte"
import { buildFlakeIndexes } from "../app/lib/indexes"
import { prefs } from "../app/lib/prefs.svelte"
import { app } from "../app/lib/state.svelte"
import { TEXT_DEFAULT_STEP, TEXT_STEPS } from "../app/lib/type-scale"
import { fixtureManifest } from "./fixtures/data"
import { withMount } from "./helpers"

function seed() {
  const m = fixtureManifest()
  app.manifest = m
  app.flakeIndexes = buildFlakeIndexes(m)
  app.selection = null
  app.aboutOpen = false
  app.q = ""
  prefs.resetTextSize()
  prefs.setTheme(0)
}

beforeEach(seed)

const sizeButtons = (host: HTMLElement) => [
  ...host.querySelectorAll<HTMLButtonElement>(".fontctl button"),
]

describe("text-size control", () => {
  test("renders icons, not a percentage or step name", () => {
    withMount(Header, {}, (host) => {
      const [smaller, reset, larger] = sizeButtons(host)
      expect(sizeButtons(host).length).toBe(3)
      // Every button is an icon — no stray label text to go stale.
      for (const b of sizeButtons(host)) expect(b.textContent?.trim()).toBe("")
      for (const b of sizeButtons(host)) expect(b.querySelector("svg.szicon")).not.toBeNull()

      // All three carry the same A; the sign is what differs. A minus is one
      // bar, a plus is that bar plus the upright, and reset has neither.
      for (const b of sizeButtons(host)) expect(b.querySelectorAll("path.letter").length).toBe(1)
      expect(smaller!.querySelectorAll("rect.sign").length).toBe(1)
      expect(larger!.querySelectorAll("rect.sign").length).toBe(2)
      expect(reset!.querySelectorAll("rect.sign").length).toBe(0)

      // The signed variants notch the A so the sign reads clear of it; the
      // plain A needs no hole, and each mask id is used once.
      const maskIds = sizeButtons(host)
        .flatMap((b) => [...b.querySelectorAll("mask")])
        .map((m) => m.id)
      expect(maskIds.sort()).toEqual(["sz-notch-down", "sz-notch-up"])
      expect(reset!.querySelector("mask")).toBeNull()
      expect(reset!.querySelector("path.letter")?.getAttribute("mask")).toBeNull()
      expect(larger!.querySelector("path.letter")?.getAttribute("mask")).toBe("url(#sz-notch-up)")

      // The size is still announced, just not painted on screen.
      expect(smaller!.getAttribute("aria-label")).toContain("currently M")
    })
  })

  test("stepping moves one scale step and disables the ends", () => {
    withMount(Header, {}, (host) => {
      const [smaller, reset, larger] = sizeButtons(host)
      // Nothing to reset at the default.
      expect(reset!.disabled).toBe(true)
      expect(smaller!.disabled).toBe(false)
      expect(larger!.disabled).toBe(false)

      larger!.click()
      flushSync()
      expect(prefs.textStep).toBe(TEXT_DEFAULT_STEP + 1)
      expect(reset!.disabled).toBe(false)

      for (let i = 0; i < TEXT_STEPS.length; i++) larger!.click()
      flushSync()
      expect(prefs.textStep).toBe(TEXT_STEPS.length - 1)
      expect(larger!.disabled).toBe(true) // clamped, so the button is a dead end
      expect(smaller!.disabled).toBe(false)

      for (let i = 0; i < TEXT_STEPS.length * 2; i++) smaller!.click()
      flushSync()
      expect(prefs.textStep).toBe(0)
      expect(smaller!.disabled).toBe(true)
      expect(larger!.disabled).toBe(false)

      reset!.click()
      flushSync()
      expect(prefs.textStep).toBe(TEXT_DEFAULT_STEP)
      expect(reset!.disabled).toBe(true)
    })
  })
})

describe("header actions", () => {
  test("theme switch reports the theme it is in, and flips it", () => {
    withMount(Header, {}, (host) => {
      const sw = host.querySelector<HTMLButtonElement>(".themesw")!
      // A switch states what it IS, so the label is fixed and the state
      // lives in aria-checked — the knob position says the same thing.
      expect(sw.getAttribute("role")).toBe("switch")
      expect(sw.getAttribute("aria-label")).toBe("Dark theme")
      expect(sw.getAttribute("aria-checked")).toBe("false")
      expect(sw.getAttribute("title")).toBe("Switch to dark theme")
      expect(sw.querySelector("svg")?.classList.contains("dark")).toBe(false)

      sw.click()
      flushSync()
      expect(prefs.themeIndex).toBe(1)
      expect(sw.getAttribute("aria-checked")).toBe("true")
      expect(sw.getAttribute("title")).toBe("Switch to light theme")
      // The whole animation hangs off this one class; everything else is CSS.
      expect(sw.querySelector("svg")?.classList.contains("dark")).toBe(true)

      sw.click()
      flushSync()
      expect(prefs.themeIndex).toBe(0)
      expect(sw.getAttribute("aria-checked")).toBe("false")
    })
  })

  test("the switch carries both faces, the moon drawn by subtraction", () => {
    withMount(Header, {}, (host) => {
      const sw = host.querySelector<HTMLButtonElement>(".themesw")!
      expect(sw.querySelectorAll(".sun .rays line").length).toBe(8)
      expect(sw.querySelector(".sun .core")).not.toBeNull()
      // The crescent is a disc minus a disc, so the mask must be wired up —
      // without it the moon renders as a plain filled circle.
      expect(sw.querySelector(".moon")?.getAttribute("mask")).toBe("url(#tsw-crescent)")
      expect(sw.querySelectorAll("mask#tsw-crescent circle").length).toBe(2)
    })
  })

  test("the wordmark clears the selection and the help button opens About", () => {
    app.selection = { kind: "file", fileId: "self:lib/c.nix" }
    withMount(Header, {}, (host) => {
      host.querySelector<HTMLButtonElement>(".home")!.click()
      flushSync()
      expect(app.selection).toBeNull()

      host.querySelector<HTMLButtonElement>(".round.help")!.click()
      flushSync()
      expect(app.aboutOpen).toBe(true)
    })
  })
})
