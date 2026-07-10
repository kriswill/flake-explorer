<script lang="ts">
import type { InputInfo } from "../../src/schema";
import { colorFor } from "../lib/color";
import { app } from "../lib/state.svelte";
import { THEMES } from "../lib/themes";
import { commitUrl, webUrl } from "../lib/url";
import Dot from "./Dot.svelte";

const { input }: { input: InputInfo } = $props();
const gen = $derived(THEMES[app.themeIndex]!.gen);
const date = $derived(
  input.lastModified ? new Date(input.lastModified * 1000).toISOString().slice(0, 10) : null,
);
const link = $derived(webUrl(input.url));
const revLink = $derived(commitUrl(input.url, input.rev));
</script>

{#snippet extIcon()}
  <svg class="ext" viewBox="0 0 16 16" width="10" height="10" aria-hidden="true" focusable="false">
    <path
      d="M6.5 3h6.5v6.5M13 3 6 10M11 8.5V13H3V5h4.5"
      fill="none"
      stroke="currentColor"
      stroke-width="1.3"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
{/snippet}

<div class="prov" style="--c:{colorFor(input.name, gen)}">
  <Dot />
  <b>input {input.name}</b>
  <span class="mono type">{input.type}{input.ref ? `:${input.ref}` : ""}</span>
  <dl>
    {#if input.url}
      <dt>url</dt>
      <dd>
        {#if link}
          <a class="urltag mono" href={link} target="_blank" rel="noopener">
            {input.url}
            {@render extIcon()}
          </a>
        {:else}
          <span class="mono">{input.url}</span>
        {/if}
      </dd>
    {/if}
    {#if input.rev}
      <dt>rev</dt>
      <dd>
        {#if revLink}
          <a class="urltag mono" href={revLink} target="_blank" rel="noopener">
            {input.rev}
            {@render extIcon()}
          </a>
        {:else}
          <span class="mono">{input.rev}</span>
        {/if}
      </dd>
    {/if}
    {#if input.narHash}<dt>narHash</dt><dd class="mono">{input.narHash}</dd>{/if}
    {#if date}<dt>locked</dt><dd>{date}</dd>{/if}
    {#if input.follows}<dt>follows</dt><dd class="mono">{input.follows}</dd>{/if}
  </dl>
</div>

<style>
  .prov {
    background: color-mix(in srgb, var(--c) 8%, var(--surface-1));
    border: 1px solid color-mix(in srgb, var(--c) 35%, var(--grid));
    border-radius: 10px;
    padding: 8px 12px;
    font-size: 0.75rem;
    margin-bottom: 8px;
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
  }
  .type {
    color: var(--ink-muted);
  }
  .mono {
    font-family: ui-monospace, monospace;
  }
  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 10px;
    margin: 4px 0 0;
    width: 100%;
  }
  dt {
    color: var(--ink-muted);
  }
  dd {
    margin: 0;
    word-break: break-all;
  }
  .urltag {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--ink-2);
    text-decoration: none;
    border-bottom: 1px solid transparent;
    transition:
      color 0.15s ease,
      border-color 0.15s ease;
  }
  .urltag:hover {
    color: var(--c);
    border-color: color-mix(in srgb, var(--c) 60%, transparent);
  }
  .urltag .ext {
    flex: none;
    opacity: 0.6;
  }
  .urltag:hover .ext {
    opacity: 1;
  }
</style>
