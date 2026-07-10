// Data loading with one code path for both serving modes: an embedded
// <script type="application/json" id="data:<name>"> tag wins (future
// single-file build); otherwise fetch from ./data/ (dev server).

export async function loadJson<T>(name: string): Promise<T> {
  if (typeof document !== "undefined") {
    const el = document.getElementById(`data:${name}`);
    if (el?.textContent) return JSON.parse(el.textContent) as T;
  }
  const res = await fetch(`data/${name}`);
  if (!res.ok)
    throw new Error(`loading ${name}: HTTP ${res.status} ${await res.text().catch(() => "")}`);
  return (await res.json()) as T;
}
