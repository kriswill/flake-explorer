import { describe, expect, test } from "bun:test"
import { normalizeShow, safeName } from "../src/extract/manifest"
import type { OutputNode } from "../src/schema"

// Captured from real `nix flake show --json path:<flake>` under Determinate
// Nix 3.21.1 (inventory v2). The flake had packages for x86_64-linux (the
// host) and aarch64-linux (filtered), a `lib` attr (no `output` key), and a
// template with a description.
const inventoryV2 = {
  inventory: {
    packages: {
      doc: "The `packages` flake output contains packages that can be added to a shell using `nix shell`.\n",
      output: {
        children: {
          "aarch64-linux": { filtered: true },
          "x86_64-linux": {
            children: {
              hello: {
                derivation: { name: "hello-1.0" },
                forSystems: ["x86_64-linux"],
                shortDescription: "",
                what: "package",
              },
            },
          },
        },
      },
    },
    lib: { unknown: true },
    templates: {
      doc: "The `templates` output provides project templates.\n",
      output: {
        children: {
          default: { shortDescription: "a template", what: "template" },
        },
      },
    },
  },
  version: 2,
}

// Hand-built to match the classic (Nix/Lix) wire format: nested plain
// objects, leaves carry {type, name?, description?}, other-system attrs
// appear as {}, and unclassifiable outputs as {"unknown": true}.
const classic = {
  packages: {
    "x86_64-linux": {
      hello: { type: "derivation", name: "hello-1.0", description: "A friendly greeter" },
      blank: { type: "derivation", name: "blank-0.1", description: "" },
    },
    "aarch64-linux": {},
  },
  nixosConfigurations: {
    nebula: { type: "nixos-configuration" },
  },
  lib: { unknown: true },
}

describe("normalizeShow (inventory v2)", () => {
  const out = normalizeShow(inventoryV2)
  const children = (out as Extract<OutputNode, { kind: "attrset" }>).children

  test("top level becomes an attrset keyed by output name", () => {
    expect(out.kind).toBe("attrset")
    expect(Object.keys(children).sort()).toEqual(["lib", "packages", "templates"])
  })

  test("leaf carries what/derivation.name; empty shortDescription is dropped", () => {
    const pkgs = children.packages as Extract<OutputNode, { kind: "attrset" }>
    const linux = pkgs.children["x86_64-linux"] as Extract<OutputNode, { kind: "attrset" }>
    expect(linux.children.hello).toEqual({
      kind: "leaf",
      type: "package",
      name: "hello-1.0",
      description: undefined,
    })
  })

  test("non-empty shortDescription propagates; derivation-less leaf has no name", () => {
    const tpl = children.templates as Extract<OutputNode, { kind: "attrset" }>
    expect(tpl.children.default).toEqual({
      kind: "leaf",
      type: "template",
      name: undefined,
      description: "a template",
    })
  })

  test("{filtered: true} nodes become omitted", () => {
    const pkgs = children.packages as Extract<OutputNode, { kind: "attrset" }>
    expect(pkgs.children["aarch64-linux"]).toEqual({ kind: "omitted" })
  })

  test("inventory entry without an output key becomes unknown", () => {
    expect(children.lib).toEqual({ kind: "unknown" })
  })

  test("output node with neither filtered/children/what becomes unknown", () => {
    const out = normalizeShow({ version: 2, inventory: { odd: { output: {} } } })
    const children = (out as Extract<OutputNode, { kind: "attrset" }>).children
    expect(children.odd).toEqual({ kind: "unknown" })
  })
})

describe("normalizeShow (classic)", () => {
  const out = normalizeShow(classic)
  const children = (out as Extract<OutputNode, { kind: "attrset" }>).children

  test("nested objects become nested attrsets", () => {
    expect(out.kind).toBe("attrset")
    expect(Object.keys(children).sort()).toEqual(["lib", "nixosConfigurations", "packages"])
  })

  test("leaf propagates type/name/description", () => {
    const pkgs = children.packages as Extract<OutputNode, { kind: "attrset" }>
    const linux = pkgs.children["x86_64-linux"] as Extract<OutputNode, { kind: "attrset" }>
    expect(linux.children.hello).toEqual({
      kind: "leaf",
      type: "derivation",
      name: "hello-1.0",
      description: "A friendly greeter",
    })
  })

  test("empty-string description is dropped; missing name stays undefined", () => {
    const pkgs = children.packages as Extract<OutputNode, { kind: "attrset" }>
    const linux = pkgs.children["x86_64-linux"] as Extract<OutputNode, { kind: "attrset" }>
    expect(linux.children.blank).toEqual({
      kind: "leaf",
      type: "derivation",
      name: "blank-0.1",
      description: undefined,
    })
    const nixos = children.nixosConfigurations as Extract<OutputNode, { kind: "attrset" }>
    expect(nixos.children.nebula).toEqual({
      kind: "leaf",
      type: "nixos-configuration",
      name: undefined,
      description: undefined,
    })
  })

  test("empty attrset (other-system output) becomes omitted", () => {
    const pkgs = children.packages as Extract<OutputNode, { kind: "attrset" }>
    expect(pkgs.children["aarch64-linux"]).toEqual({ kind: "omitted" })
  })

  test("{unknown: true} becomes unknown", () => {
    expect(children.lib).toEqual({ kind: "unknown" })
  })

  test("null and non-object input become unknown", () => {
    expect(normalizeShow(null)).toEqual({ kind: "unknown" })
    expect(normalizeShow("nope")).toEqual({ kind: "unknown" })
    expect(normalizeShow(42)).toEqual({ kind: "unknown" })
  })
})

describe("safeName", () => {
  test("a name containing % is slugified, not passed through", () => {
    // "%" must never survive into a dataFile name: the serve route
    // percent-decodes request paths, so a literal "%" would be reinterpreted
    // as a URL escape (e.g. "..%2F" traversal).
    expect(safeName("foo%2Fbar")).toMatch(/^foo_2Fbar-[0-9a-z]{1,8}$/)
  })
})
