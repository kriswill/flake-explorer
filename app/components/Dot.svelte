<script lang="ts">
  // The one true dot. Color comes from the inherited --c custom property.
  // dir: embeds a disclosure triangle (right = collapsed, down = open).
  // hollow: tinted fill + ring, for nodes with nothing customized.
  interface Props {
    dir?: boolean;
    open?: boolean;
    hollow?: boolean;
  }
  const { dir = false, open = false, hollow = false }: Props = $props();
</script>

<span class="dot" class:dir class:open class:hollow></span>

<style>
  .dot {
    width: 0.65rem;
    height: 0.65rem;
    border-radius: 50%;
    background: var(--c, var(--ink-muted));
    flex: none;
    position: relative;
  }
  .dot.hollow {
    background: color-mix(in srgb, var(--c, var(--ink-muted)) 22%, transparent);
    box-shadow: inset 0 0 0 1.5px var(--c, var(--ink-muted));
  }
  .dot.dir::after {
    content: "";
    position: absolute;
    left: 55%;
    top: 50%;
    translate: -50% -50%;
    border-left: 0.28rem solid var(--surface-1);
    border-top: 0.2rem solid transparent;
    border-bottom: 0.2rem solid transparent;
  }
  .dot.dir.open::after {
    left: 50%;
    top: 55%;
    border-left: 0.2rem solid transparent;
    border-right: 0.2rem solid transparent;
    border-top: 0.28rem solid var(--surface-1);
    border-bottom: none;
  }
  .dot.dir.hollow::after {
    border-left-color: var(--c, var(--ink-muted));
  }
  .dot.dir.open.hollow::after {
    border-left-color: transparent;
    border-top-color: var(--c, var(--ink-muted));
  }
</style>
