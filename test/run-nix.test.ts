// run-nix wrapper tests against a fake `nix` shim on PATH — hermetic (no
// real nix needed, CI's test job has none) and lets each failure mode be
// scripted exactly: version gates, exit codes, timeouts, directory retries.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  attrSelector,
  checkNix,
  derivationShow,
  evalExtract,
  flakeMetadata,
  flakeShow,
  NixError,
  pathInfo,
  readInputFile,
  runJson,
} from "../src/extract/run-nix"

// Behavior is selected per-test via NIX_SHIM (Bun.spawn inherits process.env).
const SHIM = `#!/bin/sh
case "$NIX_SHIM" in
  version) echo "nix (Nix) 2.34.7" ;;
  version-old) echo "nix (Nix) 2.18.1" ;;
  version-odd) echo "nix, experimental build" ;;
  echo-args) echo "\\"$*\\"" ;;
  args-to-file) printf '%s' "$*" > "$NIX_SHIM_OUT"; printf '{"ok":true}' ;;
  json) printf '{"ok":true}' ;;
  fail) echo "error: something exploded" >&2; exit 3 ;;
  hang) exec sleep 30 ;;
  readfile)
    case "$*" in
      *default.nix*) printf "the file contents" ;;
      *) echo "error: cannot read: Is a directory" >&2; exit 1 ;;
    esac ;;
  path-info-null)
    for last; do :; done
    printf '{"%s": null}' "$last" ;;
  path-info-value)
    for last; do :; done
    printf '{"%s": {"narSize": 123, "closureSize": 456, "references": ["/nix/store/a", "/nix/store/b"]}}' "$last" ;;
  *) echo "unexpected NIX_SHIM=$NIX_SHIM" >&2; exit 9 ;;
esac
`

let shimDir: string
const origPath = process.env.PATH
const origShim = process.env.NIX_SHIM

beforeAll(async () => {
  shimDir = await mkdtemp(join(tmpdir(), "nix-shim-"))
  await Bun.write(join(shimDir, "nix"), SHIM)
  await chmod(join(shimDir, "nix"), 0o755)
  process.env.PATH = `${shimDir}:${origPath}`
})

afterAll(async () => {
  process.env.PATH = origPath
  if (origShim === undefined) delete process.env.NIX_SHIM
  else process.env.NIX_SHIM = origShim
  await rm(shimDir, { recursive: true, force: true })
})

const shim = (mode: string) => {
  process.env.NIX_SHIM = mode
}

describe("checkNix", () => {
  test("accepts a recent version", async () => {
    shim("version")
    expect(await checkNix()).toBe("nix (Nix) 2.34.7")
  })

  test("rejects nix older than the minimum", async () => {
    shim("version-old")
    await expect(checkNix()).rejects.toThrow("needs nix >= 2.19, found: nix (Nix) 2.18.1")
  })

  test("unparseable version output passes through (benefit of the doubt)", async () => {
    shim("version-odd")
    expect(await checkNix()).toBe("nix, experimental build")
  })

  test("missing nix binary yields the install hint", async () => {
    const empty = join(shimDir, "empty")
    await mkdir(empty, { recursive: true })
    process.env.PATH = empty
    try {
      await expect(checkNix()).rejects.toThrow("needs `nix` on PATH")
    } finally {
      process.env.PATH = `${shimDir}:${origPath}`
    }
  })
})

describe("run / runJson", () => {
  test("non-zero exit throws NixError with exit code and stderr attached", async () => {
    shim("fail")
    const err = await runJson(["eval", "--json"], 5_000).catch((e) => e as NixError)
    expect(err).toBeInstanceOf(NixError)
    expect((err as NixError).exitCode).toBe(3)
    expect((err as NixError).stderr).toContain("something exploded")
    expect((err as NixError).message).toContain("failed (exit 3)")
  })

  test("a hung nix is killed at the timeout", async () => {
    shim("hang")
    const err = await runJson(["eval"], 250).catch((e) => e as NixError)
    expect(err).toBeInstanceOf(NixError)
    expect((err as NixError).message).toContain("nix eval timed out after 0.25s")
  })
})

describe("command construction", () => {
  test("flakeMetadata and flakeShow pass the expected argv (incl. lazy-trees off)", async () => {
    shim("echo-args")
    const argvOf = (p: Promise<unknown>) => p as Promise<string>
    expect(await argvOf(flakeMetadata("/my/flake"))).toBe(
      "--option lazy-trees false flake metadata --json /my/flake",
    )
    expect(await argvOf(flakeShow("/my/flake", false))).toBe(
      "--option lazy-trees false flake show --json /my/flake",
    )
    expect(await argvOf(flakeShow("/my/flake", true))).toBe(
      "--option lazy-trees false flake show --json --all-systems /my/flake",
    )
  })

  test("evalExtract evaluates extract.nix with JSON-embedded args", async () => {
    shim("json")
    const result = await evalExtract<{ ok: boolean }>({ flakeRef: "/f", mode: "manifest" }, 5_000)
    expect(result).toEqual({ ok: true })
  })

  test("evalExtract quotes the extract.nix path (npm installs live under node_modules/@scope)", async () => {
    shim("args-to-file")
    const out = join(shimDir, "argv.txt")
    process.env.NIX_SHIM_OUT = out
    try {
      await evalExtract({ flakeRef: "/f", mode: "manifest" }, 5_000)
    } finally {
      delete process.env.NIX_SHIM_OUT
    }
    const argv = await Bun.file(out).text()
    const extractNix = join(import.meta.dir, "../src/extract/extract.nix")
    expect(argv).toContain(`import ${JSON.stringify(extractNix)} `)
  })
})

describe("readInputFile", () => {
  test("retries a directory module as <dir>/default.nix", async () => {
    shim("readfile")
    expect(await readInputFile("/f", "vendor", "modules/sops")).toBe("the file contents")
  })

  test("non-directory errors pass through untouched", async () => {
    shim("fail")
    await expect(readInputFile("/f", "vendor", "modules/sops.nix")).rejects.toThrow(NixError)
  })
})

describe("attrSelector", () => {
  test("bare nix identifiers pass through unquoted", () => {
    expect(attrSelector(["packages", "x86_64-linux", "rtk"])).toBe("packages.x86_64-linux.rtk")
    expect(attrSelector(["formatter", "x86_64-linux"])).toBe("formatter.x86_64-linux")
  })

  test("segments with special characters get JSON-quoted", () => {
    expect(attrSelector(["packages", "x86_64-linux", "my.pkg name"])).toBe(
      'packages.x86_64-linux."my.pkg name"',
    )
    expect(attrSelector(["a", "1abc"])).toBe('a."1abc"') // digit-first isn't a bare identifier
  })
})

describe("derivationShow", () => {
  test("builds argv with --impure and the (quoted) flake attr path", async () => {
    shim("echo-args")
    const argvOf = (p: Promise<unknown>) => p as Promise<string>
    expect(
      await argvOf(derivationShow("/my/flake", ["packages", "x86_64-linux", "rtk"])),
    ).toBe("--option lazy-trees false derivation show --impure /my/flake#packages.x86_64-linux.rtk")
  })
})

describe("pathInfo", () => {
  // Verified against a running nix (see extract.nix's outputInfo comment):
  // this always exits 0 — a path not yet realized in the store maps to
  // `null` in the JSON rather than a nonzero exit code.
  test("a path missing from the store resolves to null, not a thrown error", async () => {
    shim("path-info-null")
    expect(await pathInfo("/nix/store/xxx-thing")).toBeNull()
  })

  test("a valid path returns its narSize/closureSize/references", async () => {
    shim("path-info-value")
    expect(await pathInfo("/nix/store/xxx-thing")).toEqual({
      narSize: 123,
      closureSize: 456,
      references: ["/nix/store/a", "/nix/store/b"],
    })
  })
})
