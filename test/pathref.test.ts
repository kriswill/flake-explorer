import { describe, expect, test } from "bun:test";
import { REL_PATH_RE, resolveKnownRef, resolveRelRef } from "../src/pathref";

const matches = (text: string): string[] => text.match(REL_PATH_RE) ?? [];

describe("resolveRelRef", () => {
  test("collapses . and .. segments", () => {
    expect(resolveRelRef("a/b", "./c")).toBe("a/b/c");
    expect(resolveRelRef("a/b", "../c")).toBe("a/c");
    expect(resolveRelRef("a/b", "../../c.nix")).toBe("c.nix");
    expect(resolveRelRef("a", "./b/../c")).toBe("a/c");
  });

  test("empty dir resolves against the root", () => {
    expect(resolveRelRef("", "./x.nix")).toBe("x.nix");
    expect(resolveRelRef("", "./sub/y.nix")).toBe("sub/y.nix");
  });

  test("returns null when the token escapes the root", () => {
    expect(resolveRelRef("", "../x.nix")).toBeNull();
    expect(resolveRelRef("a", "../../x.nix")).toBeNull();
    expect(resolveRelRef("a/b", "../../../x.nix")).toBeNull();
  });
});

describe("resolveKnownRef", () => {
  test("resolves a sibling reference relative to the referencing file's dir", () => {
    const known = new Set(["modules/a.nix", "modules/b.nix"]);
    expect(resolveKnownRef("modules/a.nix", "./b.nix", known)).toBe("modules/b.nix");
  });

  test("returns null when the token escapes the root", () => {
    // from is at the root, so dirname is "" and '../../x.nix' pops past it
    expect(resolveKnownRef("a.nix", "../../x.nix", new Set(["x.nix"]))).toBeNull();
  });

  test("falls back to <target>/default.nix like Nix directory imports", () => {
    const known = new Set(["flake.nix", "modules/default.nix"]);
    expect(resolveKnownRef("flake.nix", "./modules", known)).toBe("modules/default.nix");
  });

  test("self-import returns null", () => {
    const known = new Set(["modules/a.nix"]);
    expect(resolveKnownRef("modules/a.nix", "./a.nix", known)).toBeNull();
  });

  test("returns null for unknown targets", () => {
    expect(resolveKnownRef("a.nix", "./missing.nix", new Set(["a.nix"]))).toBeNull();
  });
});

describe("REL_PATH_RE", () => {
  test("matches quoted and bare relative tokens", () => {
    expect(matches('import "./x"')).toEqual(["./x"]);
    expect(matches("imports = [ ../x/y.nix ./dir ];")).toEqual(["../x/y.nix", "./dir"]);
  });

  test("accepts @ + - . characters in segments", () => {
    expect(matches("import ./pkgs/foo@2.1+beta-3.nix")).toEqual(["./pkgs/foo@2.1+beta-3.nix"]);
  });

  test("known limitation: non-ASCII filenames truncate at the first unicode char", () => {
    // \w is ASCII-only in JS, so the token stops at 'ó' — the import edge is
    // silently dropped (a false negative, per the module's philosophy). This
    // pins CURRENT behavior; widening the char class must update this test.
    expect(matches("import ./módulo.nix")).toEqual(["./m"]);
    expect(resolveKnownRef("flake.nix", "./m", new Set(["módulo.nix"]))).toBeNull();
  });
});
