// Shared "scroll into view when selected" Svelte action for tree rows.
// Extracted from FileTreeBranch's inline `reveal` — the module tree and
// outputs tree need the same behavior for deep-link orientation: expanding
// ancestors gets the row into the DOM, this gets it into the viewport.

/** Scroll `el` into view whenever `active()` flips true (reactive). */
export function revealWhen(el: HTMLElement, active: () => boolean) {
  $effect(() => {
    if (active()) el.scrollIntoView?.({ block: "nearest" })
  })
}
