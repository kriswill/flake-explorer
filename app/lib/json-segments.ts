// Syntax-colored JSON rendering shared by OptionRow and OptionDetail.

export interface JsonSeg {
  text: string
  cls?: string
}

/** Walks a parsed JSON value and emits {text, cls} runs, matching JSON.stringify(v, null, 2)'s layout. */
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
      segs.push({ text: nextIndent }, ...jsonSegments(item, nextIndent))
      segs.push({ text: i < value.length - 1 ? ",\n" : "\n" })
    })
    segs.push({ text: `${indent}]` })
    return segs
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
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
