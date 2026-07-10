import { mount } from "svelte"
import App from "./App.svelte"
import { app } from "./lib/state.svelte"
import "./components/tree-connectors.css"

const prefersDark =
  typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)").matches : false
app.initTheme(prefersDark)

app.initFontScale()
app.initPanes()
app.initRouting()
void app.loadManifest()

mount(App, { target: document.getElementById("app")! })
