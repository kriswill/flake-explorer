import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { collectAbout } from "../src/licenses";

describe("collectAbout", () => {
  const about = collectAbout(join(import.meta.dir, ".."));

  test("first-party identity: MIT with copyright and license text", () => {
    expect(about.name).toBe("Flake Explorer");
    expect(about.license).toBe("MIT");
    expect(about.copyright).toContain("Kris Williams");
    expect(about.text).toContain("Permission is hereby granted");
    expect(about.url).toBe("https://github.com/kriswill/flake-explorer");
  });

  test("bundled deps carry their license texts; build tooling excluded", () => {
    const names = about.deps.map((d) => d.name);
    expect(names).toContain("svelte");
    expect(names).not.toContain("bun-plugin-svelte"); // BUILD_ONLY
    const svelte = about.deps.find((d) => d.name === "svelte")!;
    expect(svelte.license).toBe("MIT");
    expect(svelte.text.length).toBeGreaterThan(200);
  });
});
