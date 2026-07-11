// Client entry bundled by build-docs.ts into assets/mermaid.js. Renders
// <pre class="mermaid"> blocks; without JS they stay visible as source.

import mermaid from "mermaid"

mermaid.initialize({
  startOnLoad: false,
  theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default",
})
void mermaid.run()
