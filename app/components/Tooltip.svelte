<script lang="ts">
import { PRIO } from "../lib/schema"
import { app } from "../lib/state.svelte"

const prioLabel = (p: number | undefined) => {
  if (p === undefined) return null
  if (p === PRIO.mkForce) return "mkForce"
  if (p === PRIO.mkDefault) return "mkDefault"
  if (p === PRIO.optionDefault) return "option default"
  if (p === PRIO.plain) return null // plain definition — not noteworthy
  return `mkOverride ${p}`
}

const short = (v: unknown) => {
  const s = JSON.stringify(v)
  return s === undefined ? "—" : s.length > 120 ? `${s.slice(0, 120)}…` : s
}

// Clamp to the viewport so the tip never runs off-screen.
const pos = $derived.by(() => {
  if (!app.tip) return { left: 0, top: 0 }
  const w = typeof window === "undefined" ? 1200 : window.innerWidth
  const h = typeof window === "undefined" ? 800 : window.innerHeight
  return { left: Math.min(app.tip.x + 14, w - 360), top: Math.min(app.tip.y + 14, h - 180) }
})
</script>

{#if app.tip}
  {@const o = app.tip.entry}
  <div id="tip" style="left:{pos.left}px; top:{pos.top}px">
    <b>{o.loc.join(".")}</b>
    {#if o.type}<span class="t">{o.type}</span>{/if}
    <div class="kv">
      <span class="k">default</span>
      <span class="v">{o.defaultText ?? (o.default !== undefined ? short(o.default) : "—")}</span>
    </div>
    {#if prioLabel(o.highestPrio)}
      <div class="kv"><span class="k">priority</span><span class="v prio">{prioLabel(o.highestPrio)}</span></div>
    {/if}
    {#if o.description}
      <div class="d">{o.description.length > 220 ? o.description.slice(0, 220) + "…" : o.description}</div>
    {/if}
  </div>
{/if}

<style>
  #tip {
    position: fixed;
    pointer-events: none;
    max-width: 340px;
    background: var(--surface-1);
    border: 1px solid var(--grid);
    border-radius: 8px;
    padding: 8px 10px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
    z-index: 3;
    font-size: var(--text-2xs);
  }
  #tip b {
    display: block;
    font-family: ui-monospace, monospace;
    font-size: var(--text-2xs);
  }
  .t {
    color: var(--ink-muted);
  }
  .kv {
    display: flex;
    gap: 6px;
    margin-top: 3px;
  }
  .k {
    color: var(--ink-muted);
    flex: none;
  }
  .v {
    font-family: ui-monospace, monospace;
    word-break: break-all;
  }
  .prio {
    color: var(--warn);
  }
  .d {
    color: var(--ink-2);
    margin-top: 4px;
  }
</style>
