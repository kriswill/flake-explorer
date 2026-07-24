// Shared "scroll into view when selected" attachment for tree rows and the
// source view's ?L= line. Reactivity comes from the {@attach} expression
// itself: when its dependencies change, a fresh attachment runs — so callers
// pass the boolean directly, no getter closure needed.

import type { Attachment } from "svelte/attachments"

/** Scroll the element into view when `active` is true. */
export function revealWhen(active: boolean, block: ScrollLogicalPosition = "nearest"): Attachment {
  return (el) => {
    if (active) el.scrollIntoView?.({ block })
  }
}
