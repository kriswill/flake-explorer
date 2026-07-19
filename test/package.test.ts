// Pure/offline unit tests for package.ts: classifyBuilder, the
// normalizeDerivationShow shape normalizer (both nix JSON shapes), and
// normalizePackageMeta's license/maintainer/platform shaping. No nix needed —
// extractPackage's real-nix path is covered by mini-flake.test.ts.

import { describe, expect, test } from "bun:test"
import {
  classifyBuilder,
  normalizeDerivationShow,
  normalizePackageMeta,
} from "../src/extract/package"

describe("classifyBuilder", () => {
  const noMarkers = { cargoDeps: false, goModules: false, npmDeps: false, buildCommand: false }

  test("eval markers win first, in priority order", () => {
    expect(classifyBuilder({ ...noMarkers, cargoDeps: true }, [], true)).toBe("rustPlatform")
    expect(classifyBuilder({ ...noMarkers, goModules: true }, [], true)).toBe("buildGoModule")
    expect(classifyBuilder({ ...noMarkers, npmDeps: true }, [], true)).toBe("node")
    expect(classifyBuilder({ ...noMarkers, buildCommand: true }, [], true)).toBe("trivial")
    // cargoDeps checked before goModules even if both are somehow set.
    expect(classifyBuilder({ ...noMarkers, cargoDeps: true, goModules: true }, [], true)).toBe(
      "rustPlatform",
    )
  })

  test("falls back to a nativeBuildInputs hook-name scan", () => {
    expect(classifyBuilder(noMarkers, ["cargo-build-hook"], false)).toBe("rustPlatform")
    expect(classifyBuilder(noMarkers, ["go-modules-hook"], false)).toBe("buildGoModule")
    expect(classifyBuilder(noMarkers, ["npm-install-hook"], false)).toBe("node")
    expect(classifyBuilder(noMarkers, ["gcc-wrapper", "cargo-build-hook"], false)).toBe(
      "rustPlatform",
    )
  })

  test("phase presence (no markers/hooks) means a plain stdenv derivation", () => {
    expect(classifyBuilder(noMarkers, ["gcc-wrapper"], true)).toBe("stdenv")
  })

  test("nothing recognized falls back to unknown", () => {
    expect(classifyBuilder(noMarkers, [], false)).toBe("unknown")
    expect(classifyBuilder(noMarkers, ["gcc-wrapper"], false)).toBe("unknown")
  })
})

describe("normalizeDerivationShow", () => {
  test("newer nix: {derivations:{...}} wrapper, nested inputs.drvs", async () => {
    const raw = {
      derivations: {
        "4zsdqwbpxpa6k66shvx0zdqcvka7gwqx-mini-0.1.0.drv": {
          name: "mini-0.1.0",
          system: "x86_64-linux",
          builder: "/bin/sh",
          env: { buildPhase: "make", doCheck: "1", __structuredAttrs: "0" },
          inputs: {
            drvs: { "w5yviq1l1r6g8ldwwv7f8fyxg5qs9pm0-mini-dep.drv": { outputs: ["out"] } },
            srcs: [],
          },
          outputs: { out: { path: "nqyyz2zifbk34ra2x44m534ma4lsnp6y-mini-0.1.0" } },
        },
      },
      version: 4,
    }
    const drv = await normalizeDerivationShow(raw)
    expect(drv?.drvPath).toBe("/nix/store/4zsdqwbpxpa6k66shvx0zdqcvka7gwqx-mini-0.1.0.drv")
    expect(drv?.system).toBe("x86_64-linux")
    expect(drv?.builderPath).toBe("/bin/sh")
    expect(drv?.inputDrvs).toEqual([
      {
        drvPath: "/nix/store/w5yviq1l1r6g8ldwwv7f8fyxg5qs9pm0-mini-dep.drv",
        name: "mini-dep",
        outputs: ["out"],
      },
    ])
    expect(drv?.phases.map(({ name, script }) => ({ name, script }))).toEqual([
      { name: "buildPhase", script: "make" },
    ])
    expect(drv?.doCheck).toBe(true)
    expect(drv?.structuredAttrs).toBe(false)
    expect(drv?.strictDeps).toBeUndefined() // key absent from env -> field absent
  })

  test("older nix: bare drv map at the top level, flat inputDrvs", async () => {
    const raw = {
      "aaaa1111111111111111111111111111-foo.drv": {
        name: "foo",
        system: "aarch64-darwin",
        builder: "/nix/store/bash/bin/bash",
        env: {},
        inputDrvs: { "bbbb2222222222222222222222222222-bar.drv": { outputs: ["out", "dev"] } },
      },
    }
    const drv = await normalizeDerivationShow(raw)
    expect(drv?.drvPath).toBe("/nix/store/aaaa1111111111111111111111111111-foo.drv")
    expect(drv?.system).toBe("aarch64-darwin")
    expect(drv?.inputDrvs).toEqual([
      {
        drvPath: "/nix/store/bbbb2222222222222222222222222222-bar.drv",
        name: "bar",
        outputs: ["out", "dev"],
      },
    ])
    expect(drv?.phases).toEqual([])
  })

  test("phases follow the fixed order with pre/post hooks interleaved per phase", async () => {
    const raw = {
      derivations: {
        "cccc3333333333333333333333333333-x.drv": {
          name: "x",
          system: "x86_64-linux",
          builder: "/bin/sh",
          env: {
            postUnpack: "u2",
            preUnpack: "u1",
            buildPhase: "b",
            installPhase: "i",
          },
        },
      },
    }
    const drv = await normalizeDerivationShow(raw)
    expect(drv?.phases.map((p) => p.name)).toEqual([
      "preUnpack",
      "postUnpack",
      "buildPhase",
      "installPhase",
    ])
  })

  test("a long phase script is capped", async () => {
    const script = "x".repeat(5000)
    const raw = {
      derivations: {
        "dddd4444444444444444444444444444-x.drv": {
          name: "x",
          system: "x86_64-linux",
          builder: "/bin/sh",
          env: { buildPhase: script },
        },
      },
    }
    const drv = await normalizeDerivationShow(raw)
    expect(drv?.phases[0]?.script.length).toBeLessThan(script.length)
    expect(drv?.phases[0]?.script).toContain("truncated")
  })

  test("empty/malformed input returns null instead of throwing", async () => {
    expect(await normalizeDerivationShow(null)).toBeNull()
    expect(await normalizeDerivationShow({})).toBeNull()
    expect(await normalizeDerivationShow({ derivations: {} })).toBeNull()
    expect(await normalizeDerivationShow("not an object")).toBeNull()
  })
})

describe("normalizePackageMeta", () => {
  test("license: string, single attrs, and a mixed list all normalize to a list", () => {
    expect(normalizePackageMeta({ license: "MIT" }).license).toEqual([{ shortName: "MIT" }])
    expect(normalizePackageMeta({ license: { shortName: "mit", free: true } }).license).toEqual([
      { shortName: "mit", fullName: undefined, spdxId: undefined, url: undefined, free: true },
    ])
    expect(normalizePackageMeta({ license: ["MIT", { shortName: "asl20" }] }).license).toEqual([
      { shortName: "MIT" },
      {
        shortName: "asl20",
        fullName: undefined,
        spdxId: undefined,
        url: undefined,
        free: undefined,
      },
    ])
  })

  test("absent/empty fields become undefined, not empty arrays", () => {
    const m = normalizePackageMeta({})
    expect(m.license).toBeUndefined()
    expect(m.maintainers).toBeUndefined()
    expect(m.platforms).toBeUndefined()
    expect(m.description).toBeUndefined()
  })

  test("maintainers are capped at 20", () => {
    const maintainers = Array.from({ length: 30 }, (_, i) => ({ name: `m${i}` }))
    expect(normalizePackageMeta({ maintainers }).maintainers?.length).toBe(20)
  })

  test("platforms are capped at 64 and non-strings are dropped", () => {
    const platforms = [...Array.from({ length: 70 }, (_, i) => `sys-${i}`), 42, null]
    expect(normalizePackageMeta({ platforms }).platforms?.length).toBe(64)
  })

  test("scalar fields pass through as-is", () => {
    const m = normalizePackageMeta({
      description: "a thing",
      homepage: "https://example.com",
      mainProgram: "thing",
      position: "/nix/store/x/default.nix:1",
      broken: true,
      unfree: false,
    })
    expect(m).toMatchObject({
      description: "a thing",
      homepage: "https://example.com",
      mainProgram: "thing",
      position: "/nix/store/x/default.nix:1",
      broken: true,
      unfree: false,
    })
  })
})
