// underReadableRoot: the confinement behind the /data/file/ route. The route
// reads a caller-supplied absolute path off local disk, so this predicate is
// the only thing standing between "show me a module's source" and "show me
// ~/.ssh/id_rsa" — worth testing on its own, away from a running server.

import { describe, expect, test } from "bun:test"
import { underReadableRoot } from "../src/serve"

const FLAKE = "/home/k/src/dotfiles"

describe("allowed", () => {
  test("anything under the nix store", () => {
    expect(underReadableRoot("/nix/store/abc-source/lib/modules.nix", FLAKE)).toBe(true)
    // Option declarations routinely point into an input's store copy.
    expect(underReadableRoot("/nix/store/xyz-nixpkgs/nixos/modules/misc/ids.nix", FLAKE)).toBe(true)
  })

  test("anything under the flake's own tree, including the root itself", () => {
    expect(underReadableRoot(`${FLAKE}/modules/nixos/zsh.nix`, FLAKE)).toBe(true)
    expect(underReadableRoot(FLAKE, FLAKE)).toBe(true)
  })

  test("a trailing slash on the configured flake path is tolerated", () => {
    expect(underReadableRoot(`${FLAKE}/flake.nix`, `${FLAKE}/`)).toBe(true)
  })
})

describe("refused", () => {
  test("arbitrary readable files elsewhere on disk", () => {
    for (const p of [
      "/home/k/.ssh/id_rsa",
      "/home/k/.aws/credentials",
      "/etc/shadow",
      "/tmp/whatever.nix",
    ]) {
      expect(underReadableRoot(p, FLAKE)).toBe(false)
    }
  })

  test("traversal that climbs out of an allowed root", () => {
    expect(underReadableRoot(`${FLAKE}/../../../etc/passwd`, FLAKE)).toBe(false)
    expect(underReadableRoot("/nix/store/../../etc/passwd", FLAKE)).toBe(false)
    // Normalizes to the flake root's parent, which is not itself allowed.
    expect(underReadableRoot(`${FLAKE}/..`, FLAKE)).toBe(false)
  })

  test("siblings that merely share a prefix", () => {
    // The separator matters: "/nix/store-evil" must not read as "/nix/store".
    expect(underReadableRoot("/nix/store-evil/leak.nix", FLAKE)).toBe(false)
    expect(underReadableRoot("/nix/storeroom/leak.nix", FLAKE)).toBe(false)
    expect(underReadableRoot(`${FLAKE}-backup/secrets.nix`, FLAKE)).toBe(false)
  })

  test("the bare store root, which is a directory and never a source file", () => {
    expect(underReadableRoot("/nix/store", FLAKE)).toBe(false)
  })

  test("an empty flake path does not turn everything into a prefix match", () => {
    // "".startsWith-style bugs would make every path allowed.
    expect(underReadableRoot("/home/k/.ssh/id_rsa", "")).toBe(false)
    expect(underReadableRoot("/nix/store/abc-source/x.nix", "")).toBe(true)
  })
})
