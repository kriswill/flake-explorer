<script lang="ts">
  import { app } from "./lib/state.svelte";
  import Header from "./components/Header.svelte";
  import OutputsTree from "./components/OutputsTree.svelte";
  import Stage from "./components/Stage.svelte";
  import FileList from "./components/FileList.svelte";
  import Tooltip from "./components/Tooltip.svelte";
</script>

<div class="shell">
  <Header />
  {#if app.manifestError}
    <div class="err">
      <p>Failed to load flake data: {app.manifestError}</p>
      <button onclick={() => app.loadManifest()}>Retry</button>
    </div>
  {:else if !app.manifest}
    <div class="err"><p class="muted">Loading flake data…</p></div>
  {:else}
    <main>
      <nav class="pane left"><OutputsTree /></nav>
      <section class="pane stage"><Stage /></section>
      <aside class="pane right"><FileList /></aside>
    </main>
  {/if}
  <Tooltip />
</div>

<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: var(--page);
    color: var(--ink-1);
  }
  main {
    flex: 1;
    display: grid;
    grid-template-columns: minmax(240px, 300px) 1fr minmax(280px, 340px);
    gap: 1px;
    background: var(--grid);
    min-height: 0;
  }
  .pane {
    background: var(--surface-1);
    overflow-y: auto;
    min-height: 0;
  }
  .stage {
    background: var(--page);
  }
  .err {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
  }
  .muted {
    color: var(--ink-muted);
  }
  button {
    background: var(--surface-1);
    color: var(--ink-1);
    border: 1px solid var(--grid);
    border-radius: 6px;
    padding: 6px 14px;
    cursor: pointer;
  }
</style>
