<script lang="ts">
import { displayLabel, type OutputNode } from "../lib/schema"
import { app } from "../lib/state.svelte"

interface Props {
  /** Output-tree path: ["overlays"] (category root) or ["overlays", name]. */
  path: string[]
  /** The nix-flake-show node at `path`, when it exists. */
  leaf: OutputNode | null
}
const { path, leaf }: Props = $props()

const name = $derived(path[1] ?? null)

/** Union of evaluated attr names (outputNames) and scanned definition sites. */
const allNames = $derived.by(() => {
  const names = new Set<string>(app.manifest?.outputNames?.overlays ?? [])
  for (const d of app.manifest?.overlayDefs ?? []) names.add(d.name)
  return [...names].sort()
})

const defs = $derived((app.manifest?.overlayDefs ?? []).filter((d) => d.name === name))
const defFor = (n: string) => (app.manifest?.overlayDefs ?? []).find((d) => d.name === n) ?? null

/** Files importing a definition site — usually the file that attaches the overlay. */
const importedBy = (fileId: string) => [...(app.flakeIndexes?.importedBy.get(fileId) ?? [])].sort()

/** Top-level attrs the overlay adds/overrides, merged across definition sites
 *  (override wins). Empty when no body was scannable — see the honest note. */
const attrs = $derived.by(() => {
  const byName = new Map<string, "add" | "override">()
  for (const d of defs) {
    for (const a of d.attrs ?? []) {
      if (!byName.has(a.name) || a.kind === "override") byName.set(a.name, a.kind)
    }
  }
  return [...byName]
    .map(([n, kind]) => ({ name: n, kind }))
    .sort((a, b) => a.name.localeCompare(b.name))
})

/**
 * An overlay attr `foo` is `pkgs.foo`; a `packages.<system>.foo` output
 * re-exposes it, so link there. Restricted to the `packages` category — a
 * devShell/check/formatter sharing a name (e.g. "default") is NOT the package.
 * Built once as a name→ref map; first system wins for a multi-system name (same
 * derivation on each). The overlay's own name is not enough — the added attr
 * name is (gh-op adds `gh`), so key on attr, resolved at the call site.
 */
const pkgByName = $derived.by(() => {
  const map = new Map<string, string[]>() // attr name -> package output path
  for (const p of app.manifest?.packages ?? []) {
    const attr = p.path.at(-1)
    if (p.path[0] === "packages" && attr && !map.has(attr)) map.set(attr, p.path)
  }
  return map
})
const pkgForAttr = (n: string) => pkgByName.get(n) ?? null
</script>

{#if !name}
  <h2 class="mono">overlays</h2>
  {#if allNames.length === 0}
    <p class="muted">No overlays found in this flake.</p>
  {:else}
    <ul class="plain">
      {#each allNames as n (n)}
        <li>
          <button class="link mono" onclick={() => app.select({ kind: "output", path: ["overlays", n] })}>{n}</button>
          {#if defFor(n)}<span class="muted mono">{displayLabel(defFor(n)!.file)}</span>{/if}
        </li>
      {/each}
    </ul>
  {/if}
{:else}
  <h2 class="mono">overlays.{name}</h2>
  {#if leaf?.kind === "leaf"}
    <p><span class="k">type</span> {leaf.type}</p>
  {/if}

  <section>
    <h3>Defined in</h3>
    {#if defs.length === 0}
      <p class="muted">
        Definition site not found — only <span class="mono">overlays.{name} = …</span> and
        <span class="mono">flake.overlays = &lbrace; … &rbrace;</span> source forms are scanned.
      </p>
    {:else}
      <ul class="plain">
        {#each defs as d (d.file)}
          <li>
            <button class="link mono" onclick={() => app.select({ kind: "file", fileId: d.file })}>{displayLabel(d.file)}</button>
          </li>
          {#each importedBy(d.file) as f (f)}
            <li class="indent">
              <span class="muted">imported by</span>
              <button class="link mono" onclick={() => app.select({ kind: "file", fileId: f })}>{displayLabel(f)}</button>
            </li>
          {/each}
        {/each}
      </ul>
    {/if}
  </section>

  {#if defs.length}
    <section>
      <h3>Adds / overrides <span class="count">{attrs.length}</span></h3>
      {#if attrs.length === 0}
        <p class="muted">
          No top-level attrs detected — an empty overlay, or an anonymous/computed
          form the source scan can't read (only <span class="mono">final: prev: &lbrace; … &rbrace;</span> bodies are enumerated).
        </p>
      {:else}
        <ul class="plain">
          {#each attrs as a (a.name)}
            {@const pkgPath = pkgForAttr(a.name)}
            <li>
              {#if pkgPath}
                <button class="link mono" onclick={() => app.select({ kind: "output", path: pkgPath })}>{a.name}</button>
              {:else}
                <span class="mono">{a.name}</span>
              {/if}
              <span class="chip {a.kind}">{a.kind}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
{/if}

<style>
  h2 {
    margin: 0 0 8px;
    font-size: var(--text-md);
  }
  .mono {
    font-family: ui-monospace, monospace;
  }
  .muted {
    color: var(--ink-muted);
    font-size: var(--text-xs);
  }
  .k {
    color: var(--ink-muted);
    margin-right: 6px;
  }
  p {
    margin: 4px 0;
    font-size: var(--text-xs);
  }
  section {
    border-top: 1px solid var(--grid);
    padding-top: 10px;
    margin-top: 12px;
  }
  h3 {
    margin: 0 0 6px;
    font-size: var(--text-xs);
  }
  .plain {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: var(--text-xs);
  }
  .plain li {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .plain li.indent {
    margin-left: 14px;
  }
  .link {
    background: none;
    border: none;
    padding: 0;
    color: var(--link);
    font-size: var(--text-xs);
    cursor: pointer;
    text-align: left;
    word-break: break-all;
  }
  .link:hover {
    text-decoration: underline;
  }
  .count {
    color: var(--ink-muted);
    font-weight: normal;
  }
  .chip {
    font-size: var(--text-3xs);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 1px 6px;
    border-radius: 8px;
    border: 1px solid var(--grid);
    color: var(--ink-muted);
  }
  .chip.override {
    color: var(--warn);
    border-color: color-mix(in srgb, var(--warn) 45%, transparent);
  }
</style>
