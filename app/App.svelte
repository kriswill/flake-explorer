<script lang="ts">
import AboutModal from "./components/AboutModal.svelte"
import FileList from "./components/FileList.svelte"
import Header from "./components/Header.svelte"
import OutputsTree from "./components/OutputsTree.svelte"
import Splitter from "./components/Splitter.svelte"
import Stage from "./components/Stage.svelte"
import Tooltip from "./components/Tooltip.svelte"
import { prefs } from "./lib/prefs.svelte"
import { app } from "./lib/state.svelte"
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
    <main style="grid-template-columns: {prefs.paneLeft}px 6px 1fr 6px {prefs.paneRight}px">
      <nav class="pane left"><OutputsTree /></nav>
      <Splitter side="left" />
      <section class="pane stage"><Stage /></section>
      <Splitter side="right" />
      <aside class="pane right"><FileList /></aside>
    </main>
  {/if}
  <Tooltip />
  {#if app.aboutOpen}
    <AboutModal onClose={() => (app.aboutOpen = false)} />
  {/if}
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
    min-height: 0;
  }
  .pane {
    background: var(--surface-1);
    overflow-y: auto;
    min-height: 0;
    min-width: 0;
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
