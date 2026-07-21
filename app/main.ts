import { mount } from "svelte"
import App from "./App.svelte"
import { prefs } from "./lib/prefs.svelte"
import { app } from "./lib/state.svelte"
import "./components/tree-connectors.css"

const prefersDark =
  typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)").matches : false
prefs.initTheme(prefersDark)

prefs.initTextSize()
prefs.initPanes()
app.initRouting()
void app.loadManifest()

mount(App, { target: document.getElementById("app")! })
