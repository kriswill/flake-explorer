// Shared test utilities for component tests under happy-dom.

import { flushSync, mount, unmount } from "svelte"

/** Mount a component into a fresh host element, run assertions, always unmount. */
export function withMount(
  component: unknown,
  props: Record<string, unknown>,
  fn: (host: HTMLElement) => void,
) {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const instance = mount(component as Parameters<typeof mount>[0], { target: host, props })
  try {
    flushSync()
    fn(host)
  } finally {
    void unmount(instance)
    host.remove()
  }
}

/** Buttons in the host whose text includes `text` (rows are all <button>s). */
export function buttonsWithText(host: HTMLElement, text: string): HTMLButtonElement[] {
  return [...host.querySelectorAll("button")].filter((b) => b.textContent?.includes(text))
}
