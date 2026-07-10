// Component interaction tests: fixture data injected straight into the app
// singleton, components mounted under happy-dom.

import { beforeEach, describe, expect, test } from "bun:test";
import { flushSync, mount, unmount } from "svelte";
import ModuleDetail from "../app/components/ModuleDetail.svelte";
import FileList from "../app/components/FileList.svelte";
import OutputsTree from "../app/components/OutputsTree.svelte";
import { buildConfigIndexes, buildFlakeIndexes } from "../app/lib/indexes";
import { app } from "../app/lib/state.svelte";
import { fixtureConfig, fixtureManifest } from "./fixtures/data";

function seed() {
  const manifest = fixtureManifest();
  const config = fixtureConfig();
  const fx = buildFlakeIndexes(manifest);
  app.manifest = manifest;
  app.flakeIndexes = fx;
  app.configs = { "nixos/test": { data: config, indexes: buildConfigIndexes(manifest, config, fx) } };
  app.selection = null;
  app.hover = null;
  app.q = "";
  app.showAll = false;
  app.expanded.clear();
}

function withMount(
  component: unknown,
  props: Record<string, unknown>,
  fn: (host: HTMLElement) => void,
) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const instance = mount(component as Parameters<typeof mount>[0], { target: host, props });
  try {
    flushSync();
    fn(host);
  } finally {
    void unmount(instance);
    host.remove();
  }
}

beforeEach(seed);

describe("OutputsTree", () => {
  test("renders output categories and expands to a config module tree", () => {
    withMount(OutputsTree, {}, (host) => {
      expect(host.textContent).toContain("nixosConfigurations");
      expect(host.textContent).toContain("packages");

      app.expanded.add("out:nixosConfigurations");
      app.expanded.add("cfg:nixos/test");
      flushSync();
      expect(host.textContent).toContain("test");
      expect(host.textContent).toContain("modules");

      app.expanded.add("dir:self/modules");
      flushSync();
      expect(host.textContent).toContain("a.nix");
    });
  });

  test("hovered file highlights matching tree nodes", () => {
    withMount(OutputsTree, {}, (host) => {
      app.selection = { kind: "config", configId: "nixos/test" };
      app.expanded.add("out:nixosConfigurations");
      app.expanded.add("cfg:nixos/test");
      app.expanded.add("dir:self/modules");
      app.hover = { kind: "file", fileId: "self:modules/a.nix" };
      flushSync();
      expect(host.querySelectorAll(".row.hl").length).toBeGreaterThan(0);
    });
  });
});

describe("ModuleDetail", () => {
  test("shows Configures and Declares sections with priority chips", () => {
    app.selection = { kind: "module", configId: "nixos/test", moduleId: "self:modules/a.nix" };
    withMount(ModuleDetail, { configId: "nixos/test", moduleId: "self:modules/a.nix" }, (host) => {
      expect(host.textContent).toContain("Configures");
      expect(host.textContent).toContain("services.x.enable");
      expect(host.textContent).toContain("sops.secrets");
      expect(host.textContent).toContain("mkForce"); // prio 50 chip
      expect(host.textContent).toContain("declares no options");
    });
  });

  test("declares section hides untouched options until toggled", () => {
    app.selection = { kind: "module", configId: "nixos/test", moduleId: "self:modules/sub/b.nix" };
    withMount(ModuleDetail, { configId: "nixos/test", moduleId: "self:modules/sub/b.nix" }, (host) => {
      expect(host.textContent).toContain("services.x.enable");
      expect(host.textContent).not.toContain("services.x.port");
      app.showAll = true;
      flushSync();
      expect(host.textContent).toContain("services.x.port");
    });
  });
});

describe("font scale", () => {
  test("adjusts, clamps, persists to localStorage, and restores", () => {
    app.setFontScale(1);
    app.adjustFontScale(0.1);
    expect(app.fontScale).toBe(1.1);
    expect(localStorage.getItem("flake-explorer:font-scale@2")).toBe("1.1");
    // 100% == 22.4px base (the old 140%), so 1.1 => 24.64px
    expect(document.documentElement.style.fontSize).toBe("24.64px");

    app.setFontScale(99);
    expect(app.fontScale).toBe(1.5); // clamped

    app.fontScale = 0; // simulate a fresh session
    app.initFontScale(); // restores the clamped saved value
    expect(app.fontScale).toBe(1.5);

    localStorage.removeItem("flake-explorer:font-scale@2");
    app.initFontScale();
    expect(app.fontScale).toBe(1);
  });
});

describe("theme", () => {
  test("persists the chosen theme; saved choice beats the OS preference", () => {
    app.setTheme(1);
    expect(app.themeIndex).toBe(1);
    expect(localStorage.getItem("flake-explorer:theme@1")).toBe("1");
    expect(document.documentElement.style.getPropertyValue("color-scheme")).toBe("dark");

    app.themeIndex = 0; // simulate a fresh session
    app.initTheme(false); // OS prefers light, but the saved choice wins
    expect(app.themeIndex).toBe(1);

    app.setTheme(99); // out of bounds — ignored
    expect(app.themeIndex).toBe(1);

    localStorage.removeItem("flake-explorer:theme@1");
    app.initTheme(false); // nothing saved — falls back to the OS preference
    expect(app.themeIndex).toBe(0);
  });
});

describe("pane widths", () => {
  test("clamps, persists on save, and restores", () => {
    app.resetPanes();
    app.setPane("left", 5000);
    expect(app.paneLeft).toBe(640); // clamped to max
    app.setPane("right", 10);
    expect(app.paneRight).toBe(200); // clamped to min
    app.savePanes();

    app.paneLeft = 0;
    app.paneRight = 0;
    app.initPanes();
    expect(app.paneLeft).toBe(640);
    expect(app.paneRight).toBe(200);

    app.resetPanes();
    expect(app.paneLeft).toBe(280);
    expect(app.paneRight).toBe(340);
  });
});

describe("FileList", () => {
  test("renders groups as folder trees; files hidden until folder expands", () => {
    withMount(FileList, {}, (host) => {
      expect(host.textContent).toContain("/etc/test"); // self group header
      expect(host.textContent).toContain("sops-nix"); // input group from config
      expect(host.textContent).toContain("modules/"); // grey folder row
      expect(host.textContent).not.toContain("a.nix"); // collapsed by default
      app.fileExpanded.add("fdir:self/modules");
      flushSync();
      expect(host.textContent).toContain("a.nix");
      expect(host.textContent).toContain("sub/"); // nested folder now visible
    });
  });

  test("selecting a module on the left auto-expands and highlights its file", () => {
    withMount(FileList, {}, (host) => {
      app.select({ kind: "module", configId: "nixos/test", moduleId: "self:modules/sub/b.nix" });
      flushSync();
      expect(app.fileExpanded.has("fdir:self/modules")).toBe(true);
      expect(app.fileExpanded.has("fdir:self/modules/sub")).toBe(true);
      const row = host.querySelector(".row.modsel");
      expect(row?.textContent).toContain("b.nix");
    });
  });

  test("import-related files get tinted when a file is selected", () => {
    withMount(FileList, {}, (host) => {
      app.fileExpanded.add("fdir:self/modules");
      app.fileExpanded.add("fdir:self/modules/sub");
      app.selection = { kind: "file", fileId: "self:lib/c.nix" };
      flushSync();
      // a.nix and sub/b.nix import c.nix — both rows carry .rel
      expect(host.querySelectorAll(".row.rel").length).toBe(2);
    });
  });

  test("filter hides non-matching subtrees and auto-reveals matches", () => {
    withMount(FileList, {}, (host) => {
      app.q = "sub/b";
      flushSync();
      expect(host.textContent).toContain("b.nix"); // revealed without manual expand
      expect(host.textContent).not.toContain("a.nix");
      expect(host.textContent).not.toContain("lib/"); // subtree without matches hidden
      expect(host.textContent).not.toContain("sops-nix"); // group without matches hidden
    });
  });
});
