<!-- Small "go elsewhere" button for a detail page's title row (icon + label +
     arrow) — e.g. FileDetail's "module"/"package" links back to their owning
     view, PackageDetail's "file" link to its source position. The trailing
     diagonal arrow is the same at-a-glance "this navigates away" signal
     InputProvenance's external-link icon uses for outbound urls. -->
<script lang="ts">
import type { Snippet } from "svelte"

interface Props {
  label: string
  onclick: () => void
  icon: Snippet
}
const { label, onclick, icon }: Props = $props()
</script>

<button class="chip mono" {onclick}>
  {@render icon()}
  {label}
  <!-- diagonal arrow -->
  <svg class="arrow" viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" focusable="false">
    <path
      d="M6 10 10 6M8 6h2v2"
      fill="none"
      stroke="currentColor"
      stroke-width="1.3"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
</button>

<style>
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
    background: var(--surface-1);
    border: 1px solid var(--grid);
    border-radius: 7px;
    color: var(--ink-2);
    font-size: var(--text-2xs);
    font-weight: 500;
    padding: 4px 10px;
    cursor: pointer;
    flex: none;
    transition:
      background-color 0.15s ease,
      border-color 0.15s ease,
      color 0.15s ease;
  }
  .chip:hover {
    background: var(--page);
    border-color: var(--c);
    color: var(--c);
  }
  .chip:active {
    transform: translateY(1px);
  }
  .chip :global(svg) {
    flex: none;
  }
  .chip .arrow {
    opacity: 0.6;
  }
  .chip:hover .arrow {
    opacity: 1;
  }
</style>
