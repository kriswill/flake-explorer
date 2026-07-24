import { GlobalRegistrator } from "@happy-dom/global-registrator"

/**
 * Bun's native network/stream globals, captured BEFORE happy-dom overrides
 * them. serve.test.ts needs the real network stack (Bun.serve rejects
 * handler responses that aren't Bun's own Response) — it swaps exactly these
 * back in for its duration instead of unregistering happy-dom wholesale:
 * re-registering mints a FRESH window/document, and Svelte's client runtime
 * caches document-level state at init, so components mounted in later test
 * files can crash depending on file order (bun's file order follows
 * directory enumeration, so it reshuffles whenever the repo's file set
 * changes — this bit as a "random" OptionDetail mount failure in CI).
 */
export const BUN_NATIVES: Record<string, unknown> = {}
for (const key of [
  "fetch",
  "Response",
  "Request",
  "Headers",
  "ReadableStream",
  "WritableStream",
  "TransformStream",
  "TextEncoder",
  "TextDecoder",
  "AbortController",
  "AbortSignal",
  "Blob",
  "FormData",
  "URL",
  "URLSearchParams",
]) {
  BUN_NATIVES[key] = (globalThis as Record<string, unknown>)[key]
}

GlobalRegistrator.register()

// Deterministic fallbacks for APIs the viewer touches at init time.
const g = globalThis as Record<string, unknown>
if (typeof g.matchMedia !== "function") {
  g.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })
}
if (typeof g.ResizeObserver !== "function") {
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}
