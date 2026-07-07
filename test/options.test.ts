import { describe, expect, test } from "bun:test";
import { buildFileIndex } from "../src/extract/options";
import type { OptionEntry } from "../src/schema";

const entry = (over: Partial<OptionEntry>): OptionEntry => ({
  loc: ["x"],
  internal: false,
  visible: true,
  readOnly: false,
  isDefined: true,
  customized: false,
  declarations: [],
  definitions: [],
  ...over,
});

describe("buildFileIndex", () => {
  test("defines counts only customized definitions; declares counts all", () => {
    const options = [
      entry({
        loc: ["a"],
        customized: true,
        declarations: [{ file: "/f/decl.nix" }],
        definitions: [{ file: "/f/def.nix", value: 1 }],
      }),
      entry({
        loc: ["b"],
        customized: false, // defaulted — its definition points at the declaring module
        declarations: [{ file: "/f/decl.nix" }],
        definitions: [{ file: "/f/decl.nix", value: 2 }],
      }),
    ];
    const idx = buildFileIndex(options);
    expect(idx["/f/def.nix"]).toEqual({ defines: [0], declares: [] });
    expect(idx["/f/decl.nix"]).toEqual({ defines: [], declares: [0, 1] });
  });
});
