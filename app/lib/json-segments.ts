// Syntax-colored JSON rendering shared by OptionRow and OptionDetail.

export interface JsonSeg {
  text: string
  cls?: string
}

/**
 * Walks a parsed JSON value and emits {text, cls} runs whose concatenated
 * text equals JSON.stringify(v, null, 2). Extractor output is already JSON,
 * so the unserializable cases (undefined, functions) can't arrive from
 * there — they are handled anyway so the invariant holds unconditionally
 * for any caller passing a live JS object.
 */
export function jsonSegments(value: unknown, indent: string): JsonSeg[] {
  if (value === null || typeof value === "boolean")
    return [{ text: JSON.stringify(value), cls: "tok-atom" }]
  if (typeof value === "number") return [{ text: JSON.stringify(value), cls: "tok-number" }]
  if (typeof value === "string") return [{ text: JSON.stringify(value), cls: "tok-string" }]

  const nextIndent = `${indent}  `
  if (Array.isArray(value)) {
    if (value.length === 0) return [{ text: "[]" }]
    const segs: JsonSeg[] = [{ text: "[\n" }]
    value.forEach((item, i) => {
      // JSON.stringify turns an unserializable array slot into null rather
      // than dropping it, because dropping would shift every later index.
      const item2 = item === undefined || typeof item === "function" ? null : item
      segs.push({ text: nextIndent }, ...jsonSegments(item2, nextIndent))
      segs.push({ text: i < value.length - 1 ? ",\n" : "\n" })
    })
    segs.push({ text: `${indent}]` })
    return segs
  }
  if (typeof value === "object") {
    // ...whereas an unserializable OBJECT value drops its key entirely.
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined && typeof v !== "function",
    )
    if (entries.length === 0) return [{ text: "{}" }]
    const segs: JsonSeg[] = [{ text: "{\n" }]
    entries.forEach(([k, v], i) => {
      segs.push(
        { text: nextIndent },
        { text: JSON.stringify(k), cls: "tok-key" },
        { text: ": " },
        ...jsonSegments(v, nextIndent),
      )
      segs.push({ text: i < entries.length - 1 ? ",\n" : "\n" })
    })
    segs.push({ text: `${indent}}` })
    return segs
  }
  return [{ text: String(value) }]
}
