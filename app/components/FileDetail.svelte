<script lang="ts">
  import Dot from "./Dot.svelte";
  import { app } from "../lib/state.svelte";
  import { colorFor } from "../lib/color";
  import { THEMES } from "../lib/themes";
  import InputProvenance from "./InputProvenance.svelte";
  import { REL_PATH_RE, resolveKnownRef } from "../../src/pathref";
  import type { FileOrigin } from "../../src/schema";

  const { fileId }: { fileId: string } = $props();

  const gen = $derived(THEMES[app.themeIndex]!.gen);
  const manifestEntry = $derived(app.manifest?.files.find((f) => f.id === fileId) ?? null);

  /** Config-side view of this file (any loaded config that references it). */
  const configView = $derived.by(() => {
    for (const [configId, slot] of Object.entries(app.configs)) {
      if (typeof slot !== "object" || !("indexes" in slot)) continue;
      const meta = slot.indexes.filesById.get(fileId);
      if (meta) return { configId, slot, meta, refs: slot.indexes.refsByFile.get(fileId)! };
    }
    return null;
  });

  const relPath = $derived(manifestEntry?.relPath ?? configView?.meta.relPath ?? fileId);
  const inputName = $derived.by(() => {
    const origin = manifestEntry?.origin ?? configView?.meta.origin;
    return origin?.kind === "input" ? origin.input : null;
  });
  const inputInfo = $derived(inputName ? (app.manifest?.inputs[inputName] ?? null) : null);
  const colorKey = $derived(inputName ?? fileId);

  const imports = $derived([...(app.flakeIndexes?.imports.get(fileId) ?? [])]);
  const importedBy = $derived([...(app.flakeIndexes?.importedBy.get(fileId) ?? [])]);

  // ------------------------------------------------------------- source view

  const origin = $derived(manifestEntry?.origin ?? configView?.meta.origin ?? null);
  const storePath = $derived(manifestEntry?.storePath ?? configView?.meta.storePath ?? null);
  const contentSlot = $derived(app.fileContents[fileId]);

  /** manifestEntry only covers self + import-tree files; configView.meta also resolves
   *  option-only files (e.g. inside nixpkgs itself) — either way, wait for a real storePath. */
  $effect(() => {
    if (storePath) app.loadFileContent(fileId, storePath);
  });

  const sameOrigin = (a: FileOrigin, b: FileOrigin): boolean => {
    if (a.kind !== b.kind) return false;
    if (a.kind === "input" && b.kind === "input") return a.input === b.input;
    if (a.kind === "unknown" && b.kind === "unknown") return a.group === b.group;
    return true;
  };

  /** relPaths this file can address with a "./"/"../" reference: files in the same origin tree. */
  const siblingIndex = $derived.by(() => {
    const known = new Set<string>();
    const byRelPath = new Map<string, string>();
    if (origin) {
      for (const f of app.manifest?.files ?? []) {
        if (sameOrigin(f.origin, origin)) {
          known.add(f.relPath);
          byRelPath.set(f.relPath, f.id);
        }
      }
    }
    return { known, byRelPath };
  });

  interface Segment {
    text: string;
    ref?: string;
    cls?: string;
  }

  /** Tree-sitter capture name -> CSS class; unlisted/punctuation-ish captures render unstyled. */
  function tokenClass(name: string | undefined): string | undefined {
    switch (name) {
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
        return name?.startsWith("string") ? "tok-string" : undefined;
    }
  }

  interface Interval<T> {
    start: number;
    end: number;
    value: T;
  }

  function coverAt<T>(intervals: Interval<T>[], pos: number): T | undefined {
    for (const iv of intervals) if (pos >= iv.start && pos < iv.end) return iv.value;
    return undefined;
  }

  /**
   * Source split into per-line segments: tree-sitter highlight runs (server-computed)
   * and resolvable "./"/"../" file references (client-computed) are two independent
   * interval sets over the same line text — union their boundaries so a segment can
   * carry both a token class and a ref link (e.g. a colored, clickable path literal).
   */
  const lines = $derived.by(() => {
    if (!contentSlot || typeof contentSlot !== "object" || !("text" in contentSlot)) return [];
    const { text, tokens } = contentSlot;
    let lineStart = 0;
    return text.split("\n").map((line): Segment[] => {
      const lineEnd = lineStart + line.length;

      const refIntervals: Interval<string | undefined>[] = [];
      for (const m of line.matchAll(REL_PATH_RE)) {
        const idx = m.index ?? 0;
        const target = resolveKnownRef(relPath, m[0], siblingIndex.known);
        refIntervals.push({ start: idx, end: idx + m[0].length, value: target ? siblingIndex.byRelPath.get(target) : undefined });
      }

      const tokenIntervals: Interval<string>[] = [];
      for (const t of tokens) {
        if (t.end <= lineStart || t.start >= lineEnd) continue;
        tokenIntervals.push({ start: Math.max(t.start, lineStart) - lineStart, end: Math.min(t.end, lineEnd) - lineStart, value: t.name });
      }

      const bounds = [...new Set([0, line.length, ...refIntervals.flatMap((iv) => [iv.start, iv.end]), ...tokenIntervals.flatMap((iv) => [iv.start, iv.end])])].sort(
        (a, b) => a - b,
      );

      const segs: Segment[] = [];
      for (let i = 0; i < bounds.length - 1; i++) {
        const p = bounds[i]!;
        const q = bounds[i + 1]!;
        if (p === q) continue;
        segs.push({ text: line.slice(p, q), ref: coverAt(refIntervals, p), cls: tokenClass(coverAt(tokenIntervals, p)) });
      }
      if (segs.length === 0) segs.push({ text: "" });

      lineStart = lineEnd + 1; // +1 for the newline
      return segs;
    });
  });

  /** Options this file customizes, grouped per loaded config. */
  const customizes = $derived.by(() => {
    if (!configView) return [];
    return configView.refs.defines.map((i) => configView.slot.data.options[i]!);
  });

  let copied = $state(false);
  async function copyHash() {
    if (!manifestEntry?.git) return;
    await navigator.clipboard.writeText(manifestEntry.git.commit);
    copied = true;
    setTimeout(() => (copied = false), 1200);
  }

  const label = (id: string) => id.replace(/^self:/, "").replace(/^input:[^:]+:/, "");
</script>

<div class="file-detail">
  <div class="fd-head">
    <div class="head" style="--c:{colorFor(colorKey, gen)}">
      <Dot />
      <h2 class="mono">{relPath}</h2>
    </div>

    {#if inputInfo}
      <InputProvenance input={inputInfo} />
    {/if}

    {#if manifestEntry?.git}
      <div class="section">
        <h3>last commit</h3>
        <p class="mono commit">
          {manifestEntry.git.commit}
          <button class="copy" onclick={copyHash}>{copied ? "copied" : "copy"}</button>
        </p>
        <p class="muted">{manifestEntry.git.date.slice(0, 19).replace("T", " ")} — {manifestEntry.git.subject}</p>
      </div>
    {:else if inputInfo?.rev}
      <div class="section">
        <h3>locked revision</h3>
        <p class="mono commit">{inputInfo.rev}</p>
      </div>
    {/if}
  </div>

  <div class="fd-body">
    {#if !contentSlot || contentSlot === "loading"}
      <p class="muted">loading source…</p>
    {:else if "error" in contentSlot}
      <p class="muted err">
        {contentSlot.error.split("\n")[0]}
        <button class="retry" onclick={() => app.retryFileContent(fileId, storePath!)}>retry</button>
      </p>
    {:else}
      <ol class="src">
        {#each lines as segs, i (i)}
          <li>
            {#each segs as seg, j (j)}
              {#if seg.ref}
                <button class="ref {seg.cls ?? ''}" onclick={() => app.select({ kind: "file", fileId: seg.ref! })}>{seg.text}</button>
              {:else if seg.cls}
                <span class={seg.cls}>{seg.text}</span>
              {:else}{seg.text}{/if}
            {/each}
          </li>
        {/each}
      </ol>
    {/if}
  </div>

  <div class="fd-foot">
    {#if imports.length || importedBy.length}
      <div class="section">
        {#if importedBy.length}
          <h3>imported by <span class="count">{importedBy.length}</span></h3>
          <ul>
            {#each importedBy as id (id)}
              <li><button class="link mono" onclick={() => app.select({ kind: "file", fileId: id })}>{label(id)}</button></li>
            {/each}
          </ul>
        {/if}
        {#if imports.length}
          <h3>imports <span class="count">{imports.length}</span></h3>
          <ul>
            {#each imports as id (id)}
              <li><button class="link mono" onclick={() => app.select({ kind: "file", fileId: id })}>{label(id)}</button></li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}

    {#if configView}
      <div class="section">
        <h3>customizes in {configView.configId} <span class="count">{customizes.length}</span></h3>
        {#if customizes.length === 0}
          <p class="muted">No customized option values from this file.</p>
        {:else}
          <ul>
            {#each customizes.slice(0, 50) as o (o.loc.join("."))}
              <li>
                <button
                  class="link mono"
                  onclick={() => app.select({ kind: "module", configId: configView.configId, moduleId: fileId })}
                >{o.loc.join(".")}</button>
              </li>
            {/each}
            {#if customizes.length > 50}<li class="muted">… and {customizes.length - 50} more</li>{/if}
          </ul>
        {/if}
      </div>
    {:else}
      <p class="muted section">Load a configuration on the left to see which options this file affects.</p>
    {/if}
  </div>
</div>

<style>
  .file-detail {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .fd-head,
  .fd-foot {
    flex: none;
  }
  .fd-body {
    flex: 1 1 0%;
    min-height: 120px;
    overflow-y: auto;
    border-top: 1px solid var(--grid);
    padding-top: 10px;
    margin-top: 10px;
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
  }
  .count {
    color: var(--ink-muted);
    font-weight: normal;
  }
  .mono {
    font-family: ui-monospace, monospace;
  }
  .commit {
    font-size: 0.8125rem;
    word-break: break-all;
    margin: 2px 0;
  }
  .copy {
    background: var(--page);
    border: 1px solid var(--grid);
    border-radius: 4px;
    color: var(--ink-2);
    font-size: 0.6875rem;
    cursor: pointer;
    margin-left: 6px;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    font-size: 0.75rem;
  }
  .link {
    background: none;
    border: none;
    color: var(--link);
    cursor: pointer;
    font-size: 0.75rem;
    padding: 1px 0;
    text-align: left;
    word-break: break-all;
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
  p {
    margin: 3px 0;
    font-size: 0.8125rem;
  }
  .src {
    list-style: none;
    margin: 0;
    padding: 0;
    counter-reset: line;
    overflow-x: auto;
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
    color: var(--s2);
    text-decoration: underline;
  }
  .tok-comment {
    color: var(--ink-muted);
    font-style: italic;
  }
  .tok-keyword {
    color: var(--s5);
  }
  .tok-string {
    color: var(--s2);
  }
  .tok-number {
    color: var(--s3);
  }
  .tok-function {
    color: var(--s1);
  }
  .tok-builtin {
    color: var(--s6);
  }
  .tok-property {
    color: var(--s9);
  }
</style>
