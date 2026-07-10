// OptionRow: priority chips, value preview selection (own definition vs
// merged value), expandable syntax-colored JSON, and tooltip lifecycle.

import { afterEach, describe, expect, test } from "bun:test"
import { flushSync, mount, unmount } from "svelte"
import OptionRow from "../app/components/OptionRow.svelte"
import { app } from "../app/lib/state.svelte"
import { type OptionEntry, PRIO } from "../src/schema"
import { opt } from "./fixtures/data"
import { withMount } from "./helpers"

const HL = "/nix/store/xxx-source/mod.nix"

const mountRow = (entry: OptionEntry, fn: (host: HTMLElement) => void) =>
  withMount(OptionRow, { entry, highlightFile: HL }, fn)

afterEach(() => {
  app.tip = null
})

describe("priority chips", () => {
  const chipFor = (over: Partial<OptionEntry>): string | null => {
    let text: string | null = null
    mountRow(opt(["a"], { customized: true, value: 1, ...over }), (host) => {
      text = host.querySelector(".chip")?.textContent ?? null
    })
    return text
  }

  test("mkForce, mkDefault, and arbitrary mkOverride get labeled", () => {
    expect(chipFor({ highestPrio: PRIO.mkForce })).toBe("mkForce")
    expect(chipFor({ highestPrio: PRIO.mkDefault })).toBe("mkDefault")
    expect(chipFor({ highestPrio: 25 })).toBe("mkOverride 25")
  })

  test("plain-priority and non-customized options get no chip", () => {
    expect(chipFor({ highestPrio: PRIO.plain })).toBe(null)
    expect(chipFor({ customized: false, highestPrio: undefined })).toBe(null)
  })

  test("read-only options carry a read-only chip", () => {
    mountRow(opt(["a"], { readOnly: true, value: 1 }), (host) => {
      expect(host.querySelector(".chip.ro")?.textContent).toBe("read-only")
    })
  })
})

describe("value preview", () => {
  const previewOf = (over: Partial<OptionEntry>): string => {
    let text = ""
    mountRow(opt(["a"], over), (host) => {
      text = host.querySelector(".val")?.textContent ?? ""
    })
    return text
  }

  test("errors, skipped values, and default text each have a distinct preview", () => {
    expect(previewOf({ customized: true, valueError: true })).toBe("⚠ value failed to evaluate")
    expect(previewOf({ customized: true })).toBe("(value skipped)")
    expect(previewOf({ defaultText: "pkgs.hello" })).toBe("pkgs.hello")
    expect(previewOf({})).toBe("—")
    expect(previewOf({ value: { p: 1 } })).toBe('{"p":1}')
  })

  test("prefers this file's own definition over the merged value", () => {
    const entry = opt(["big", "merge"], {
      customized: true,
      value: { merged: "huge" },
      definitions: [
        { file: "/nix/store/other.nix", value: { other: true } },
        { file: HL, value: ["mine"] },
      ],
    })
    mountRow(entry, (host) => {
      expect(host.querySelector(".val")?.textContent).toBe('["mine"]')
    })
  })

  test("own definition's valueError wins too", () => {
    const entry = opt(["a"], {
      customized: true,
      value: 42,
      definitions: [{ file: HL, valueError: true }],
    })
    mountRow(entry, (host) => {
      expect(host.querySelector(".val")?.textContent).toBe("⚠ value failed to evaluate")
    })
  })
})

describe("expanded value", () => {
  test("click opens a pre matching JSON.stringify(v, null, 2) with token spans", () => {
    const value = { name: "x", n: 3.5, on: true, none: null, list: [1, "s"], empty: {}, arr: [] }
    mountRow(opt(["a"], { customized: true, value }), (host) => {
      expect(host.querySelector("pre")).toBe(null)
      host.querySelector("button")!.click()
      flushSync()
      const pre = host.querySelector("pre")!
      expect(pre.textContent).toBe(JSON.stringify(value, null, 2))
      expect(pre.querySelectorAll(".tok-key").length).toBe(7)
      expect(pre.querySelectorAll(".tok-string").length).toBe(2) // "x", "s"
      expect(pre.querySelectorAll(".tok-atom").length).toBe(2) // true, null
      expect(pre.querySelectorAll(".tok-number").length).toBe(2) // 3.5, 1
    })
  })

  test("valueless entries expand to the preview text", () => {
    mountRow(opt(["a"], { customized: true }), (host) => {
      host.querySelector("button")!.click()
      flushSync()
      expect(host.querySelector("pre")?.textContent).toBe("(value skipped)")
    })
  })
})

describe("tooltip", () => {
  test("appears after hover delay, clears on leave and on unmount", async () => {
    const entry = opt(["hovered"], { value: 1 })
    const host = document.createElement("div")
    document.body.appendChild(host)
    const instance = mount(OptionRow, {
      target: host,
      props: { entry, highlightFile: HL },
    })
    try {
      flushSync()
      const btn = host.querySelector("button")!
      btn.dispatchEvent(new MouseEvent("pointerenter", { clientX: 7, clientY: 9 }))
      await Bun.sleep(320)
      expect(app.tip).toMatchObject({ x: 7, y: 9, entry })

      btn.dispatchEvent(new MouseEvent("pointerleave"))
      expect(app.tip).toBe(null)

      // Re-arm, then unmount while the tip is showing — onDestroy releases it.
      btn.dispatchEvent(new MouseEvent("pointerenter", { clientX: 1, clientY: 2 }))
      await Bun.sleep(320)
      expect(app.tip).not.toBe(null)
    } finally {
      void unmount(instance)
      host.remove()
    }
    expect(app.tip).toBe(null)
  })
})
