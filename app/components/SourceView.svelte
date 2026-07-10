<!-- Numbered, syntax-highlighted source listing — owns the .src / .tok-*
     styles shared by FileDetail and InputDetail. Segments come from
     lib/segments.ts; ref segments render as links only when `onref` is
     given (InputDetail passes none). -->
<script lang="ts">
import type { Segment } from "../lib/segments"

interface Props {
  lines: Segment[][]
  /** Click handler for resolvable "./"/"../" references (receives the FileEntry.id). */
  onref?: (fileId: string) => void
}
const { lines, onref }: Props = $props()
</script>

<ol class="src">
  {#each lines as segs, i (i)}
    <li>
      {#each segs as seg, j (j)}
        {#if seg.ref && onref}
          <button class="ref {seg.cls ?? ''}" onclick={() => onref(seg.ref!)}>{seg.text}</button>
        {:else if seg.cls}
          <span class={seg.cls}>{seg.text}</span>
        {:else}{seg.text}{/if}
      {/each}
    </li>
  {/each}
</ol>

<style>
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
  .ref {
    background: none;
    border: none;
    margin: 0;
    padding: 0;
    font: inherit;
    white-space: inherit;
    color: var(--link);
    cursor: pointer;
  }
  .ref.tok-string {
    color: var(--code-string);
    text-decoration: underline;
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
