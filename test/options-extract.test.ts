// extractOptions chunk-splitting / ladder-degradation tests against a fake
// `nix` shim on PATH — hermetic (no real nix, same technique as
// run-nix.test.ts). The shim parses the extract.nix args embedded in --expr
// and answers from a scenario JSON file (env FE_OPTIONS_SCENARIO), keyed on
// the request args so matching is order-independent under the worker pool.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { extractOptions, type OptionsProgress } from "../src/extract/options"
import type { RawOption } from "../src/extract/run-nix"
import { PRIO, SCHEMA_VERSION } from "../src/schema"

// Scenario keys ("names:<path>" | "opts:<path>|c=<children>|v=0/1|d=0/1")
// are produced by scenarioKey() inside the shim source below; the literal
// keys in each test's scenario table follow that grammar.

type ScenarioEntry = { ok: unknown } | { fail: string }
type Scenario = Record<string, ScenarioEntry>

const SHIM = String.raw`#!/usr/bin/env bun
// Fake nix for options-extract.test.ts. Key format mirrors scenarioKey() there.
// die() awaits the stderr write before process.exit — console.error followed
// by an immediate exit can lose the (piped) output before it is flushed,
// which would strip the "error:" line the tests assert on.
function scenarioKey(a) {
  const p = (a.path ?? []).join(".")
  if (a.mode === "optionNames") return "names:" + p
  const c = (a.childNames ?? []).join(",")
  return "opts:" + p + "|c=" + c + "|v=" + (a.withValues ? 1 : 0) + "|d=" + (a.withDescriptions ? 1 : 0)
}
const die = async (msg, code) => {
  await Bun.write(Bun.stderr, msg + "\n")
  process.exit(code)
}
const argv = process.argv.slice(2)
const expr = argv[argv.indexOf("--expr") + 1]
const m = expr ? expr.match(/builtins\.fromJSON ("(?:[^"\\]|\\.)*")/) : null
if (!m) {
  await die("error: shim could not find extract args in: " + argv.join(" "), 9)
}
const args = JSON.parse(JSON.parse(m[1]))
const scenario = JSON.parse(await Bun.file(process.env.FE_OPTIONS_SCENARIO).text())
const key = scenarioKey(args)
const entry = scenario[key]
if (!entry) {
  await die("error: SCENARIO MISS " + key, 1)
}
if ("fail" in entry) {
  await die("error: " + entry.fail, 1)
}
console.log(JSON.stringify(entry.ok))
`

let dir: string
let seq = 0
const origPath = process.env.PATH

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "options-extract-"))
  await Bun.write(join(dir, "nix"), SHIM)
  await chmod(join(dir, "nix"), 0o755)
  process.env.PATH = `${dir}:${origPath}`
})

afterAll(async () => {
  process.env.PATH = origPath
  delete process.env.FE_OPTIONS_SCENARIO
  await rm(dir, { recursive: true, force: true })
})

async function useScenario(s: Scenario) {
  const file = join(dir, `scenario-${seq++}.json`)
  await Bun.write(file, JSON.stringify(s))
  process.env.FE_OPTIONS_SCENARIO = file
}

/** Fully-populated RawOption; value omitted => null envelope (values skipped). */
const raw = (loc: string[], value?: unknown): RawOption => ({
  loc,
  type: "str",
  description: `desc ${loc.join(".")}`,
  readOnly: false,
  isDefined: true,
  highestPrio: PRIO.plain,
  defaultText: null,
  default: { ok: "the-default" },
  value: value === undefined ? null : { ok: value },
  declarations: [`/nix/store/src-${loc[0]}/module.nix`],
  definitions: [
    {
      file: `/nix/store/src-${loc[0]}/module.nix`,
      value: value === undefined ? null : { ok: value },
    },
  ],
})

const opts = (...options: RawOption[]): ScenarioEntry => ({ ok: { options } })

function extract(progress?: OptionsProgress[]) {
  return extractOptions("/my/flake", "nixos", "web", {
    timeoutMs: 10_000,
    concurrency: 2,
    onProgress: progress ? (p) => progress.push({ ...p }) : undefined,
  })
}

const locsOf = (r: Awaited<ReturnType<typeof extract>>) =>
  r.data.options.map((o) => o.loc.join(".")).sort()

const byLoc = (r: Awaited<ReturnType<typeof extract>>, loc: string) =>
  r.data.options.find((o) => o.loc.join(".") === loc)

test("happy path: every namespace chunk succeeds at full detail", async () => {
  await useScenario({
    "names:": { ok: ["boot", "networking", "services"] },
    "opts:boot|c=|v=1|d=1": opts(raw(["boot", "loader", "grub", "enable"], true)),
    "opts:networking|c=|v=1|d=1": opts(raw(["networking", "hostName"], "nebula")),
    "opts:services|c=|v=1|d=1": opts(raw(["services", "nginx", "enable"], false)),
  })
  const progress: OptionsProgress[] = []
  const r = await extract(progress)

  expect(r.warnings).toEqual([])
  expect(r.data.version).toBe(SCHEMA_VERSION)
  expect(r.data.id).toBe("nixos/web")
  expect(locsOf(r)).toEqual([
    "boot.loader.grub.enable",
    "networking.hostName",
    "services.nginx.enable",
  ])
  expect(byLoc(r, "networking.hostName")?.value).toBe("nebula")
  expect(byLoc(r, "networking.hostName")?.customized).toBe(true) // plain prio < optionDefault

  // fileIndex is built and points back at the right option indices.
  const i = r.data.options.findIndex((o) => o.loc[0] === "boot")
  expect(r.data.fileIndex["/nix/store/src-boot/module.nix"]).toEqual({
    defines: [i],
    declares: [i],
  })

  // One progress callback per processed chunk, done/total sane and converging.
  expect(progress.length).toBe(3)
  for (const p of progress) {
    expect(p.done).toBeGreaterThan(0)
    expect(p.done).toBeLessThanOrEqual(p.total)
  }
  expect(progress.at(-1)).toMatchObject({ done: 3, total: 3 })
})

test("split isolation: only the poisoned child degrades, siblings keep full values", async () => {
  await useScenario({
    "names:": { ok: ["services", "boot"] },
    "opts:boot|c=|v=1|d=1": opts(raw(["boot", "enable"], true)),
    // services fails whole, is listed into 4 children, then ceil-halved until
    // only ["c"] is left failing; a,b and d deliver full values throughout.
    "opts:services|c=|v=1|d=1": { fail: "boom in services" },
    "names:services": { ok: ["a", "b", "c", "d"] },
    "opts:services|c=a,b,c,d|v=1|d=1": { fail: "boom in services" },
    "opts:services|c=a,b|v=1|d=1": opts(
      raw(["services", "a", "port"], 80),
      raw(["services", "b", "port"], 81),
    ),
    "opts:services|c=c,d|v=1|d=1": { fail: "boom in services.c" },
    "opts:services|c=d|v=1|d=1": opts(raw(["services", "d", "port"], 83)),
    "opts:services|c=c|v=1|d=1": { fail: "boom in services.c" },
    // c has no listable children, so it walks the ladder and lands at rung 1.
    "names:services.c": { ok: [] },
    "opts:services|c=c|v=0|d=1": opts(raw(["services", "c", "port"])),
  })
  const r = await extract()

  expect(locsOf(r)).toEqual([
    "boot.enable",
    "services.a.port",
    "services.b.port",
    "services.c.port",
    "services.d.port",
  ])
  // Healthy siblings kept their full-detail values.
  expect(byLoc(r, "services.a.port")?.value).toBe(80)
  expect(byLoc(r, "services.b.port")?.value).toBe(81)
  expect(byLoc(r, "services.d.port")?.value).toBe(83)
  expect(byLoc(r, "boot.enable")?.value).toBe(true)
  // The poisoned child landed without a value, and only it is warned about.
  expect(byLoc(r, "services.c.port")?.value).toBeUndefined()
  expect(r.warnings).toEqual([
    "nixos/web options.services.c: values skipped (eval error at full detail)",
  ])
})

test("ladder degradation: values off succeeds after full detail fails", async () => {
  await useScenario({
    "names:": { ok: ["pkgs"] },
    "opts:pkgs|c=|v=1|d=1": { fail: "cannot serialize values" },
    "names:pkgs": { ok: [] }, // unsplittable — must walk the ladder
    "opts:pkgs|c=|v=0|d=1": opts(raw(["pkgs", "foo", "package"])),
  })
  const r = await extract()

  expect(locsOf(r)).toEqual(["pkgs.foo.package"])
  const o = byLoc(r, "pkgs.foo.package")
  expect(o?.value).toBeUndefined()
  expect(o?.description).toBe("desc pkgs.foo.package") // descriptions survived
  expect(r.warnings).toEqual(["nixos/web options.pkgs: values skipped (eval error at full detail)"])
})

test("ladder degradation: bottom rung drops descriptions too", async () => {
  await useScenario({
    "names:": { ok: ["pkgs"] },
    "opts:pkgs|c=|v=1|d=1": { fail: "cannot serialize values" },
    "names:pkgs": { ok: [] }, // consulted again at each rung — same answer
    "opts:pkgs|c=|v=0|d=1": { fail: "still broken" },
    "opts:pkgs|c=|v=0|d=0": {
      ok: { options: [{ ...raw(["pkgs", "foo", "package"]), description: null }] },
    },
  })
  const r = await extract()

  expect(locsOf(r)).toEqual(["pkgs.foo.package"])
  expect(byLoc(r, "pkgs.foo.package")?.description).toBeUndefined()
  expect(r.warnings).toEqual([
    "nixos/web options.pkgs: values+descriptions skipped (eval error at full detail)",
  ])
})

test("give-up: a chunk failing at every rung down to MAX_DEPTH terminates with one warning", async () => {
  await useScenario({
    "names:": { ok: ["deep", "ok"] },
    "opts:ok|c=|v=1|d=1": opts(raw(["ok", "opt"], 1)),
    // Single-child chain deep.a.b.c: descends a level per failure until the
    // option path hits MAX_DEPTH (4), then fails every ladder rung.
    "opts:deep|c=|v=1|d=1": { fail: "boom" },
    "names:deep": { ok: ["a"] },
    "opts:deep|c=a|v=1|d=1": { fail: "boom" },
    "names:deep.a": { ok: ["b"] },
    "opts:deep.a|c=b|v=1|d=1": { fail: "boom" },
    "names:deep.a.b": { ok: ["c"] },
    "opts:deep.a.b|c=c|v=1|d=1": { fail: "the poisoned option" },
    "opts:deep.a.b|c=c|v=0|d=1": { fail: "the poisoned option" },
    "opts:deep.a.b|c=c|v=0|d=0": { fail: "the poisoned option" },
  })
  const progress: OptionsProgress[] = []
  const r = await extract(progress) // terminating at all is part of the assertion

  // The unrelated chunk is unaffected.
  expect(locsOf(r)).toEqual(["ok.opt"])
  expect(byLoc(r, "ok.opt")?.value).toBe(1)
  // Exactly one warning, for the abandoned leaf, carrying the nix error line.
  expect(r.warnings).toEqual([
    "nixos/web options.deep.a.b.c: extraction failed — error: the poisoned option",
  ])
  expect(progress.at(-1)?.done).toBe(progress.at(-1)?.total)
})
