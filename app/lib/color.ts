// Stable colors for files, modules, and inputs. Adapted from okflight
// (viz-app/color.ts): the first N distinct keys get the theme's 12 curated
// CVD-validated slots (--s1..--s12); beyond that, FNV-1a hash → golden-angle
// hue → OKLCH at theme-tuned lightness/chroma. Pure function of (key,
// params) so a file keeps its color across regenerations.

export interface GenParams {
  l: number;
  c: number;
}

const GOLDEN_ANGLE = 137.508;

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const lin2srgb = (c: number) => {
  c = Math.max(0, Math.min(1, c));
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
};

export function oklchToHex(L: number, C: number, H: number): string {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  const to = (v: number) =>
    Math.round(lin2srgb(v) * 255)
      .toString(16)
      .padStart(2, "0");
  return "#" + to(r) + to(g) + to(bb);
}

const cache = new Map<string, string>();

/** Deterministic generated color for a key at the theme's lightness/chroma. */
export function nameColor(key: string, { l, c }: GenParams): string {
  const cacheKey = `${l}:${c}:${key}`;
  let hex = cache.get(cacheKey);
  if (!hex) {
    const hue = (fnv1a(key) * GOLDEN_ANGLE) % 360;
    hex = oklchToHex(l, c, hue);
    cache.set(cacheKey, hex);
  }
  return hex;
}

// Curated-slot registry: input names are registered first (few, prominent),
// so they land on the CVD-validated slots; files overflow to generated
// colors. Slot assignment is first-come within a page load but inputs are
// registered in manifest order, which is stable for a given flake.
const slots = new Map<string, number>();

export function registerSlotKeys(keys: string[]) {
  for (const k of keys) if (!slots.has(k) && slots.size < 12) slots.set(k, slots.size + 1);
}

/**
 * CSS color expression for a key: curated slot var when registered, else a
 * generated OKLCH hex. Use in `style="--c: {colorFor(key, gen)}"`.
 */
export function colorFor(key: string, gen: GenParams): string {
  const slot = slots.get(key);
  return slot ? `var(--s${slot})` : nameColor(key, gen);
}
