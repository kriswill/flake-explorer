import { mount } from "svelte";
import App from "./App.svelte";
import { applyThemeVars, defaultThemeIndex } from "./lib/themes";
import { app } from "./lib/state.svelte";

const prefersDark =
  typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)").matches : false;
app.themeIndex = defaultThemeIndex(prefersDark);
applyThemeVars(app.themeIndex);

app.initFontScale();
app.initPanes();
app.initRouting();
void app.loadManifest();

mount(App, { target: document.getElementById("app")! });
