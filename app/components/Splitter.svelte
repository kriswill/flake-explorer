<script lang="ts">
import { app } from "../lib/state.svelte"

const { side }: { side: "left" | "right" } = $props()

let dragging = $state(false)

function down(e: PointerEvent) {
  const el = e.currentTarget as HTMLElement
  const startX = e.clientX
  const start = side === "left" ? app.paneLeft : app.paneRight
  dragging = true
  try {
    el.setPointerCapture(e.pointerId)
  } catch {
    // synthetic events have no active pointer to capture — drag still works
  }
  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - startX
    app.setPane(side, side === "left" ? start + dx : start - dx)
  }
  const up = () => {
    dragging = false
    app.savePanes()
    el.removeEventListener("pointermove", move)
  }
  el.addEventListener("pointermove", move)
  el.addEventListener("pointerup", up, { once: true })
  el.addEventListener("pointercancel", up, { once: true })
  e.preventDefault()
}

function key(e: KeyboardEvent) {
  const step = e.shiftKey ? 64 : 16
  const dir = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0
  if (!dir) return
  const current = side === "left" ? app.paneLeft : app.paneRight
  app.setPane(side, current + dir * (side === "left" ? step : -step))
  app.savePanes()
  e.preventDefault()
}

const width = $derived(side === "left" ? app.paneLeft : app.paneRight)
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions
     (a focusable separator IS the ARIA "window splitter" widget pattern) -->
<div
  class="split"
  class:dragging
  role="separator"
  aria-orientation="vertical"
  aria-label="Resize {side} panel (double-click to reset)"
  aria-valuenow={width}
  tabindex="0"
  title="Drag to resize · double-click to reset"
  onpointerdown={down}
  ondblclick={() => app.resetPanes()}
  onkeydown={key}
></div>

<style>
  .split {
    cursor: col-resize;
    position: relative;
    /* The 1px divider line, centered in the 6px hit area. */
    background: linear-gradient(to right, transparent 2px, var(--grid) 2px, var(--grid) 3px, transparent 3px);
    touch-action: none;
  }
  .split:hover,
  .split.dragging,
  .split:focus-visible {
    background: linear-gradient(to right, transparent 1px, var(--link) 1px, var(--link) 4px, transparent 4px);
    outline: none;
  }
</style>
