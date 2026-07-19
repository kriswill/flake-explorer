// Expensive per-configuration extraction: the options tree, walked in chunks
// so an uncatchable eval error (missing attr / type error — tryEval only
// catches throw/assert) degrades instead of killing the whole configuration.
//
// Split first, degrade last: a failing chunk (an option path + optional
// child subset) is halved / descended at the SAME detail level to isolate
// the poisoned option — healthy siblings keep full values. Only an
// unsplittable leaf (or one at the depth cap) walks down the detail ladder
// (full → no values → no values+descriptions) before being abandoned.

import { cpus } from "node:os"
import {
  type ConfigData,
  type ConfigKind,
  type DefinitionRef,
  type FileOptionRefs,
  type OptionEntry,
  PRIO,
  SCHEMA_VERSION,
} from "../schema"
import {
  evalExtract,
  NixError,
  type OptionsEval,
  type RawOption,
  type ValueEnvelope,
} from "./run-nix"

export interface OptionsResult {
  data: ConfigData
  warnings: string[]
  durationMs: number
}

export interface OptionsProgress {
  done: number
  total: number
  current: string
}

const LADDER: { withValues: boolean; withDescriptions: boolean; note: string }[] = [
  { withValues: true, withDescriptions: true, note: "" },
  { withValues: false, withDescriptions: true, note: "values skipped" },
  { withValues: false, withDescriptions: false, note: "values+descriptions skipped" },
]

/** Below this depth a failing chunk is abandoned instead of split further. */
const MAX_DEPTH = 4

interface Chunk {
  path: string[]
  children?: string[]
  /** Index into LADDER — escalates only when the chunk can't split further. */
  rung: number
}

export async function extractOptions(
  flakeRef: string,
  kind: ConfigKind,
  name: string,
  opts: {
    timeoutMs?: number
    concurrency?: number
    skipInvisible?: boolean
    onProgress?: (p: OptionsProgress) => void
  } = {},
): Promise<OptionsResult> {
  const t0 = performance.now()
  const timeoutMs = opts.timeoutMs ?? 600_000
  const concurrency = opts.concurrency ?? Math.max(2, Math.min(8, cpus().length - 2))
  const skipInvisible = opts.skipInvisible ?? true
  const warnings: string[] = []
  const results: RawOption[] = []
  const label = `${kind}/${name}`

  const namespaces = await evalExtract<string[]>(
    { flakeRef, mode: "optionNames", kind, name },
    timeoutMs,
  )

  const queue: Chunk[] = namespaces.map((n) => ({ path: [n], rung: 0 }))
  let done = 0
  /** Chunks taken off the queue by sibling workers but not yet finished —
   * without them `total` dips while chunks are in flight and a callback can
   * claim done === total while siblings may still push splits. */
  let inFlight = 0

  const runChunk = async (chunk: Chunk): Promise<RawOption[] | null> => {
    const rung = LADDER[chunk.rung]!
    let lastErr = ""
    try {
      const r = await evalExtract<OptionsEval>(
        {
          flakeRef,
          mode: "options",
          kind,
          name,
          path: chunk.path,
          childNames: chunk.children,
          skipInvisible,
          withValues: rung.withValues,
          withDescriptions: rung.withDescriptions,
        },
        timeoutMs,
      )
      if (rung.note) {
        warnings.push(
          `${label} options.${chunkLabel(chunk)}: ${rung.note} (eval error at full detail)`,
        )
      }
      return r.options
    } catch (e) {
      lastErr = e instanceof NixError ? e.message : String(e)
    }

    // Failed. Prefer splitting at the same detail level to isolate the bad
    // option; healthy siblings keep full detail.
    if (chunk.children && chunk.children.length > 1) {
      const mid = Math.ceil(chunk.children.length / 2)
      queue.push({ ...chunk, children: chunk.children.slice(0, mid) })
      queue.push({ ...chunk, children: chunk.children.slice(mid) })
      return null
    }
    // Single child descends a level; a bare namespace splits by its children.
    const deeper = chunk.children ? [...chunk.path, chunk.children[0]!] : chunk.path
    if (deeper.length < MAX_DEPTH) {
      try {
        const kids = await evalExtract<string[]>(
          { flakeRef, mode: "optionNames", kind, name, path: deeper },
          timeoutMs,
        )
        if (kids.length > 0) {
          queue.push({ path: deeper, children: kids, rung: chunk.rung })
          return null
        }
      } catch {
        // unlistable — fall through to rung escalation
      }
    }
    // Unsplittable: walk down the ladder, then give up.
    if (chunk.rung + 1 < LADDER.length) {
      queue.push({ ...chunk, rung: chunk.rung + 1 })
      return null
    }
    warnings.push(`${label} options.${deeper.join(".")}: extraction failed — ${errLine(lastErr)}`)
    return null
  }

  async function worker() {
    for (;;) {
      const chunk = queue.shift()
      if (!chunk) return
      inFlight++
      try {
        const r = await runChunk(chunk)
        if (r) results.push(...r)
      } finally {
        inFlight--
      }
      done++
      opts.onProgress?.({ done, total: done + queue.length + inFlight, current: chunkLabel(chunk) })
    }
  }
  // Workers exit when the queue is momentarily empty even though a sibling
  // may still push splits; loop until the queue fully drains.
  while (queue.length > 0) {
    await Promise.all(Array.from({ length: concurrency }, worker))
  }

  const data: ConfigData = {
    version: SCHEMA_VERSION,
    id: `${kind}/${name}`,
    options: results.map(toEntry),
    fileIndex: {},
  }
  data.fileIndex = buildFileIndex(data.options)
  return { data, warnings: [...new Set(warnings)], durationMs: Math.round(performance.now() - t0) }
}

const chunkLabel = (c: Chunk) =>
  c.children?.length === 1 ? [...c.path, c.children[0]!].join(".") : c.path.join(".")

/** Last substantive `error: <msg>` line — nix prefixes traces with bare "error:" lines. */
export const errLine = (s: string) => {
  const errs = s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("error:") && l.length > "error:".length)
  return errs[errs.length - 1] ?? s.trim().split("\n")[0] ?? "unknown error"
}

/** "path, via option foo.bar" -> [path, "foo.bar"]; plain paths pass through. */
export function splitVia(file: string): [string, string | undefined] {
  const i = file.indexOf(", via option ")
  return i < 0 ? [file, undefined] : [file.slice(0, i), file.slice(i + ", via option ".length)]
}

export function unwrap(v: ValueEnvelope): {
  value?: unknown
  valueError?: true
  valueSkipped?: true
} {
  if (v && typeof v === "object" && "ok" in v) return { value: v.ok }
  if (v && typeof v === "object" && "err" in v) return { valueError: true }
  if (v && typeof v === "object" && "skipped" in v) return { valueSkipped: true }
  return {} // null — the option has no value at all
}

/**
 * Definition values are pre-merge, so scrub's {mkOverride, content} envelope
 * (a mkForce/mkDefault/mkOverride wrapper) survives here — lift it into a
 * first-class per-definition priority instead of presenting the envelope as
 * the value. Only the outermost wrapper is lifted; nested overrides are
 * pathological and keep their inner envelope.
 */
function toDefinition(d: RawOption["definitions"][number]): DefinitionRef {
  // Definition files can carry a ", via option <path>" suffix (module-system
  // provenance annotation) — strip it so file matching works.
  const ref: DefinitionRef = { file: splitVia(d.file)[0]! }
  const u = unwrap(d.value)
  if (u.valueError) ref.valueError = true
  if (u.valueSkipped) ref.valueSkipped = true
  let v = u.value
  if (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    "mkOverride" in v &&
    "content" in v &&
    Object.keys(v).length === 2
  ) {
    const w = v as { mkOverride: unknown; content: unknown }
    if (typeof w.mkOverride === "number") ref.prio = w.mkOverride
    v = w.content
  }
  if (v !== undefined) ref.value = v
  return ref
}

export function toEntry(o: RawOption): OptionEntry {
  const val = unwrap(o.value)
  const def = unwrap(o.default)
  return {
    loc: o.loc,
    type: o.type ?? undefined,
    description: o.description ?? undefined,
    readOnly: o.readOnly,
    isDefined: o.isDefined,
    highestPrio: o.highestPrio ?? undefined,
    customized: o.isDefined && o.highestPrio !== null && o.highestPrio < PRIO.optionDefault,
    value: val.value,
    valueError: val.valueError,
    valueSkipped: val.valueSkipped,
    default: def.value,
    defaultText: o.defaultText ?? undefined,
    declarations: o.declarations.map((d) => ({
      file: d.file,
      ...(d.line !== null ? { line: d.line } : {}),
      ...(d.column !== null ? { column: d.column } : {}),
    })),
    definitions: o.definitions.map(toDefinition),
  }
}

/**
 * storePath (or "<unknown-file>") -> option indices, split by role. This is
 * what makes file→module cross-highlighting O(1) in the SPA.
 * "defines" only counts CUSTOMIZED definitions: every defaulted option has a
 * definition pointing at its declaring module (mkOptionDefault), which would
 * otherwise make nixpkgs "define" everything.
 */
export function buildFileIndex(options: OptionEntry[]): Record<string, FileOptionRefs> {
  const index: Record<string, FileOptionRefs> = {}
  const at = (file: string) => (index[file] ??= { defines: [], declares: [] })
  options.forEach((o, i) => {
    // A file can declare/define the same option more than once (e.g. two
    // `environment.profiles` definitions in one module) — index it once.
    const declared = new Set<string>()
    for (const d of o.declarations) {
      if (declared.has(d.file)) continue
      declared.add(d.file)
      at(d.file).declares.push(i)
    }
    if (o.customized) {
      const defined = new Set<string>()
      for (const d of o.definitions) {
        if (defined.has(d.file)) continue
        defined.add(d.file)
        at(d.file).defines.push(i)
      }
    }
  })
  return index
}
