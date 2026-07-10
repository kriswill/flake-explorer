// State-layer routing tests: applyHash populating selection/filters and
// revealFile's id-fallback (deep link decoded before any config is loaded).
// The manifest is deliberately left null so #followSelection's loadConfig
// bails out instead of firing a real fetch under happy-dom.

import { beforeEach, describe, expect, test } from "bun:test";
import { app } from "../app/lib/state.svelte";

beforeEach(() => {
  // No manifest / no configs — forces revealFile onto the parseFileId
  // fallback and keeps loadConfig from touching the network.
  app.manifest = null;
  app.configs = {};
  app.selection = null;
  app.q = "";
  app.showAll = false;
  app.fileExpanded.clear();
});

describe("applyHash", () => {
  test("module deep link sets selection + filters and expands the file chain via id-fallback", () => {
    const hashBefore = window.location.hash;
    app.applyHash("#/c/nixos%2Ftest/m/self:modules%2Fsub%2Fb.nix?q=x&all=1");

    expect(app.selection).toEqual({
      kind: "module",
      configId: "nixos/test",
      moduleId: "self:modules/sub/b.nix",
    });
    expect(app.q).toBe("x");
    expect(app.showAll).toBe(true);
    // No config is loaded — the folder chain comes from the "self:" id alone.
    expect(app.fileExpanded.has("fdir:self/modules")).toBe(true);
    expect(app.fileExpanded.has("fdir:self/modules/sub")).toBe(true);
    // applyHash consumes the hash; it must never write one back.
    expect(window.location.hash).toBe(hashBefore);
  });

  test("file deep link into an input parses group + path out of the id", () => {
    app.applyHash("#/f/input:sops-nix:modules%2Fsops%2Fdefault.nix");

    expect(app.selection).toEqual({
      kind: "file",
      fileId: "input:sops-nix:modules/sops/default.nix",
    });
    // Group key is "input:<name>", not the bare input name.
    expect(app.fileExpanded.has("fdir:input:sops-nix/modules")).toBe(true);
    expect(app.fileExpanded.has("fdir:input:sops-nix/modules/sops")).toBe(true);
  });

  test("empty hash clears selection and filters", () => {
    app.selection = { kind: "config", configId: "nixos/test" };
    app.q = "stale";
    app.showAll = true;
    app.applyHash("");

    expect(app.selection).toBeNull();
    expect(app.q).toBe("");
    expect(app.showAll).toBe(false);
    expect(app.fileExpanded.size).toBe(0);
  });
});

describe("revealFile", () => {
  test("opaque (unknown-bucket) ids expand nothing without a loaded config", () => {
    app.revealFile("store:abc123-source/nested/file.nix");
    expect(app.fileExpanded.size).toBe(0);
  });
});
