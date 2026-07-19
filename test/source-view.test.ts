// SourceView.svelte: the numbered/highlighted source listing shared by
// FileDetail and InputDetail.

import { describe, expect, test } from "bun:test"
import SourceView from "../app/components/SourceView.svelte"
import type { Segment } from "../app/lib/segments"
import { withMount } from "./helpers"

describe("SourceView", () => {
  test("renders one <li> per line, plain segments as text", () => {
    const lines: Segment[][] = [[{ text: "a = 1;" }], [{ text: "b = 2;" }]]
    withMount(SourceView, { lines }, (host) => {
      const items = host.querySelectorAll(".src li")
      expect(items.length).toBe(2)
      expect(items[0]!.textContent).toBe("a = 1;")
      expect(items[1]!.textContent).toBe("b = 2;")
    })
  })

  test("a segment with cls but no ref renders a plain styled span", () => {
    const lines: Segment[][] = [[{ text: "let", cls: "tok-keyword" }]]
    withMount(SourceView, { lines }, (host) => {
      const span = host.querySelector("span.tok-keyword")
      expect(span?.textContent).toBe("let")
      expect(host.querySelector("button")).toBeNull()
    })
  })

  test("a ref segment renders a clickable button only when onref is given", () => {
    const lines: Segment[][] = [[{ text: "./foo.nix", ref: "self:foo.nix", cls: "tok-string" }]]

    withMount(SourceView, { lines }, (host) => {
      // No onref passed — even a ref-carrying segment stays plain (styled) text.
      expect(host.querySelector("button")).toBeNull()
      expect(host.querySelector("span.tok-string")?.textContent).toBe("./foo.nix")
    })

    let clicked: string | null = null
    withMount(SourceView, { lines, onref: (id: string) => (clicked = id) }, (host) => {
      const btn = host.querySelector("button.ref") as HTMLButtonElement
      expect(btn.textContent).toBe("./foo.nix")
      expect(btn.classList.contains("tok-string")).toBe(true)
      btn.click()
      expect(clicked).toBe("self:foo.nix")
    })
  })

  test("multiple segments on one line render in order", () => {
    const lines: Segment[][] = [
      [{ text: "let " }, { text: "x", cls: "tok-keyword" }, { text: " = 1;" }],
    ]
    withMount(SourceView, { lines }, (host) => {
      expect(host.querySelector("li")?.textContent).toBe("let x = 1;")
    })
  })
})
