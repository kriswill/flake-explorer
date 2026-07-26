// Compare two extraction data directories, modulo the fields that vary between
// any two runs. This is the fidelity half of an A/B: a change that makes
// extraction faster is only interesting if the data it produces is the same,
// and "the same" needs a definition sharp enough to catch a regression and
// loose enough not to flag the clock.
//
//   bun scripts/datadir-diff.ts [--cross-arm] <dirA> <dirB>
//
// WHAT VARIES, MEASURED RATHER THAN ASSUMED. Extracting fixtures/mini-flake
// twice with the same binary differs in exactly three fields: `durationMs` and
// `extractedAt` (in every *.meta.json sidecar and in manifest.json's
// configurations[]/packages[]), and manifest.json's top-level `generatedAt`.
// Config and package BLOBS are byte-identical run to run — that is the property
// tests/determinism.rs defends — so they are compared unnormalized here. If a
// blob moves, that is the finding.
//
// --cross-arm additionally normalizes `extractor`, the extraction fingerprint.
// Comparing two BUILDS is the one case where that field is expected to differ:
// it is a content hash of crates/extract, so any change in there moves it by
// design (see crates/extract/build.rs). Without the flag it stays strict, so
// two runs of ONE binary that disagree on it are still a failure — which is
// what makes the same-arm control worth running beside every cross-arm diff.
//
// The varying fields are REPLACED, not deleted, so a field that disappears or
// appears is still a difference. The file list is compared first: a missing
// blob is a failure, not an absence of diff output.

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

/** Fields that differ between any two runs of the same binary. */
export const RUN_VARYING = ["durationMs", "extractedAt", "generatedAt"] as const

/** Additionally expected to differ between two BUILDS, and only then. */
export const BUILD_VARYING = ["extractor"] as const

export interface DiffOptions {
  /** Also normalize the extraction fingerprint (comparing two builds). */
  crossArm?: boolean
}

export interface Finding {
  path: string
  kind: "missing" | "added" | "content"
  detail: string
}

/** Replace the varying leaves anywhere in a JSON value, at any depth. */
export function normalize(value: unknown, opts: DiffOptions = {}): unknown {
  if (Array.isArray(value)) return value.map((v) => normalize(v, opts))
  if (value === null || typeof value !== "object") return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if ((RUN_VARYING as readonly string[]).includes(k)) out[k] = "<varies per run>"
    else if (opts.crossArm && (BUILD_VARYING as readonly string[]).includes(k))
      out[k] = "<per build>"
    else out[k] = normalize(v, opts)
  }
  return out
}

/** Stable text for comparison: sorted keys, varying fields folded away. */
export function canonical(text: string, opts: DiffOptions = {}): string {
  return JSON.stringify(normalize(JSON.parse(text), opts), sortedKeys, 2)
}

function sortedKeys(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  return Object.fromEntries(entries)
}

/** Every file under `dir`, relative and sorted. */
export function fileList(dir: string): string[] {
  const out: string[] = []
  const walk = (at: string) => {
    for (const entry of readdirSync(at).sort()) {
      const full = join(at, entry)
      if (statSync(full).isDirectory()) walk(full)
      else out.push(relative(dir, full))
    }
  }
  walk(dir)
  return out.sort()
}

export function compareDirs(a: string, b: string, opts: DiffOptions = {}): Finding[] {
  const findings: Finding[] = []
  const inA = fileList(a)
  const inB = new Set(fileList(b))

  for (const rel of inA) {
    if (!inB.has(rel)) {
      findings.push({ path: rel, kind: "missing", detail: "present in A, absent in B" })
      continue
    }
    inB.delete(rel)
    const rawA = readFileSync(join(a, rel))
    const rawB = readFileSync(join(b, rel))
    if (rawA.equals(rawB)) continue
    if (!rel.endsWith(".json")) {
      findings.push({ path: rel, kind: "content", detail: "bytes differ" })
      continue
    }
    const canonA = canonical(rawA.toString("utf8"), opts)
    const canonB = canonical(rawB.toString("utf8"), opts)
    if (canonA !== canonB) {
      findings.push({ path: rel, kind: "content", detail: firstDelta(canonA, canonB) })
    }
  }
  for (const rel of inB) {
    findings.push({ path: rel, kind: "added", detail: "present in B, absent in A" })
  }
  return findings
}

/** The first line that differs, with its line number — enough to act on
 *  without printing two multi-megabyte blobs. */
export function firstDelta(a: string, b: string): string {
  const la = a.split("\n")
  const lb = b.split("\n")
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) {
      return `line ${i + 1}: ${JSON.stringify(la[i] ?? "<eof>")} vs ${JSON.stringify(lb[i] ?? "<eof>")}`
    }
  }
  return "differ only in trailing whitespace"
}

export function main(argv: string[]): number {
  const crossArm = argv.includes("--cross-arm")
  const [a, b] = argv.filter((x) => !x.startsWith("--"))
  if (!a || !b) {
    console.error("usage: datadir-diff.ts [--cross-arm] <dirA> <dirB>")
    return 2
  }
  const findings = compareDirs(a, b, { crossArm })
  const exempt = crossArm ? [...RUN_VARYING, ...BUILD_VARYING] : RUN_VARYING
  if (findings.length === 0) {
    console.log(`IDENTICAL modulo ${exempt.join("/")} (${fileList(a).length} files)`)
    return 0
  }
  for (const f of findings) console.log(`${f.kind.toUpperCase()}: ${f.path} — ${f.detail}`)
  console.log(`${findings.length} difference(s)`)
  return 1
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
