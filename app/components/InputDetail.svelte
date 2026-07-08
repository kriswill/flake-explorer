<script lang="ts">
  import { app } from "../lib/state.svelte";
  import { colorFor } from "../lib/color";
  import { THEMES } from "../lib/themes";
  import Dot from "./Dot.svelte";
  import InputProvenance from "./InputProvenance.svelte";

  const { name }: { name: string } = $props();

  const gen = $derived(THEMES[app.themeIndex]!.gen);
  const input = $derived(app.manifest?.inputs[name] ?? null);

  /** The input's own flake.nix out of the store — same id scheme as option files. */
  const fileId = $derived(`input:${name}:flake.nix`);
  const contentSlot = $derived(app.fileContents[fileId]);

  $effect(() => {
    if (input?.storePath) app.loadFileContent(fileId, `${input.storePath}/flake.nix`);
  });

  /** Tree-sitter capture name -> CSS class (subset shared with FileDetail). */
  function tokenClass(n: string | undefined): string | undefined {
    switch (n) {
      case "comment":
        return "tok-comment";
      case "keyword":
        return "tok-keyword";
      case "number":
        return "tok-number";
      case "function":
        return "tok-function";
      case "function.builtin":
      case "variable.builtin":
        return "tok-builtin";
      case "property":
        return "tok-property";
      case "escape":
        return "tok-string";
      default:
        return n?.startsWith("string") ? "tok-string" : undefined;
    }
  }

  interface Segment {
    text: string;
    cls?: string;
  }

  const lines = $derived.by(() => {
    if (!contentSlot || typeof contentSlot !== "object" || !("text" in contentSlot)) return [];
    const { text, tokens } = contentSlot;
    let lineStart = 0;
    return text.split("\n").map((line): Segment[] => {
      const lineEnd = lineStart + line.length;
      const segs: Segment[] = [];
      let pos = 0;
      for (const t of tokens) {
        if (t.end <= lineStart || t.start >= lineEnd) continue;
        const s = Math.max(t.start, lineStart) - lineStart;
        const e = Math.min(t.end, lineEnd) - lineStart;
        if (s > pos) segs.push({ text: line.slice(pos, s) });
        segs.push({ text: line.slice(s, e), cls: tokenClass(t.name) });
        pos = e;
      }
      if (pos < line.length) segs.push({ text: line.slice(pos) });
      if (segs.length === 0) segs.push({ text: "" });
      lineStart = lineEnd + 1;
      return segs;
    });
  });
</script>

<div class="input-detail">
  <div class="id-head">
    <div class="head" style="--c:{colorFor(name, gen)}">
      <Dot />
      <h2 class="mono">inputs.{name}</h2>
    </div>

    {#if !input}
      <p class="muted">No input named "{name}" in this flake.</p>
    {:else}
      <InputProvenance {input} />

      <div class="section">
        <h3>flake.nix <span class="path mono">{input.storePath ? `${input.storePath}/flake.nix` : ""}</span></h3>
      </div>
    {/if}
  </div>

  {#if input}
    <div class="id-body">
      {#if !input.storePath}
        <p class="muted">Source not available (input was not fetched during extraction).</p>
      {:else if !contentSlot || contentSlot === "loading"}
        <p class="muted">loading source…</p>
      {:else if "error" in contentSlot}
        <p class="muted err">
          {contentSlot.error.split("\n")[0]}
          <button class="retry" onclick={() => app.retryFileContent(fileId, `${input.storePath}/flake.nix`)}>retry</button>
        </p>
      {:else}
        <ol class="src">
          {#each lines as segs, i (i)}
            <li>
              {#each segs as seg, j (j)}
                {#if seg.cls}<span class={seg.cls}>{seg.text}</span>{:else}{seg.text}{/if}
              {/each}
            </li>
          {/each}
        </ol>
      {/if}
    </div>
  {/if}
</div>

<style>
  .input-detail {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .id-head {
    flex: none;
  }
  .id-body {
    flex: 1 1 0%;
    min-height: 0;
    overflow-y: auto;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  h2 {
    margin: 0;
    font-size: 0.9375rem;
    word-break: break-all;
  }
  .section {
    border-top: 1px solid var(--grid);
    padding-top: 10px;
    margin-top: 10px;
  }
  h3 {
    margin: 6px 0;
    font-size: 0.8125rem;
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .path {
    font-weight: 400;
    font-size: 0.6875rem;
    color: var(--ink-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mono {
    font-family: ui-monospace, monospace;
  }
  .muted {
    color: var(--ink-muted);
    font-size: 0.75rem;
  }
  .err {
    color: var(--err);
  }
  .retry {
    background: none;
    border: 1px solid var(--grid);
    border-radius: 4px;
    color: var(--ink-2);
    font-size: 0.6875rem;
    cursor: pointer;
    margin-left: 6px;
  }
  .src {
    list-style: none;
    margin: 0;
    padding: 0;
    counter-reset: line;
    overflow-x: auto;
    /* overflow-x:auto implies overflow-y:auto — pin it or the horizontal
       scrollbar's height triggers a second, vertical one. */
    overflow-y: hidden;
    white-space: pre;
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
    line-height: 1.5;
  }
  .src li {
    counter-increment: line;
    padding-left: 3.25em;
    position: relative;
  }
  .src li::before {
    content: counter(line);
    position: absolute;
    left: 0;
    width: 2.75em;
    text-align: right;
    color: var(--ink-muted);
    user-select: none;
  }
  .tok-comment {
    color: var(--ink-muted);
    font-style: italic;
  }
  .tok-keyword {
    color: var(--code-keyword);
  }
  .tok-string {
    color: var(--code-string);
  }
  .tok-number {
    color: var(--code-number);
  }
  .tok-function {
    color: var(--code-function);
  }
  .tok-builtin {
    color: var(--code-builtin);
  }
  .tok-property {
    color: var(--code-property);
  }
</style>
