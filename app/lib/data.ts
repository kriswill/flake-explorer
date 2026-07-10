// Data loading with one code path for both serving modes: an embedded
// <script type="application/json" id="data:<name>"> tag wins (single-file
// export); otherwise fetch from ./data/ (dev server).

/** Embedded tag's raw JSON, or null. An EMPTY tag counts as absent — loadJson
 *  falls through to fetch on one, so every helper must agree. */
function embeddedText(name: string): string | null {
  if (typeof document === "undefined") return null
  return document.getElementById(`data:${name}`)?.textContent || null
}

export function hasEmbedded(name: string): boolean {
  return embeddedText(name) !== null
}

/**
 * A single-file export embeds manifest.json; serve never does (it only embeds
 * about.json). So that one tag's presence is the static-mode signal: no
 * server behind the page, nothing to fetch or retry.
 */
export function isStatic(): boolean {
  return hasEmbedded("manifest.json")
}

export async function loadJson<T>(name: string): Promise<T> {
  const embedded = embeddedText(name)
  if (embedded !== null) return JSON.parse(embedded) as T
  const res = await fetch(`data/${name}`)
  if (!res.ok)
    throw new Error(`loading ${name}: HTTP ${res.status} ${await res.text().catch(() => "")}`)
  return (await res.json()) as T
}
