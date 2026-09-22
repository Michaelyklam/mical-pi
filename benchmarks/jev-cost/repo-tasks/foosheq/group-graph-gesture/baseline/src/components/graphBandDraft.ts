import { normalizeBand, type Band } from "../lib/eq";

const fields = ["type", "frequency", "gain", "q", "enabled"] as const;
export type BandPreview = Map<number, Partial<Omit<Band, "id">>>;

export function sameGraphBand(a: Band, b: Band): boolean {
  return a.id === b.id && fields.every((field) => a[field] === b[field]);
}

/** Keep only edited fields, not a snapshot of unrelated slots or settings. */
export function captureBandPreview(base: Band[], draft: Band[]): BandPreview {
  const patches: BandPreview = new Map();
  for (const band of draft) {
    const before = base.find((item) => item.id === band.id);
    if (!before) continue;
    const patch = Object.fromEntries(
      fields
        .filter((field) => before[field] !== band[field])
        .map((field) => [field, band[field]]),
    );
    if (Object.keys(patch).length) patches.set(band.id, patch);
  }
  return patches;
}

/** Apply active edits to today's profile; additions/removals stay parent-owned. */
export function applyBandPreview(
  bands: Band[],
  patches: BandPreview | null,
): Band[] {
  if (!patches?.size) return bands;
  return bands.map((band) =>
    patches.has(band.id) ? { ...band, ...patches.get(band.id) } : band,
  );
}

/** Quantize only the axis being edited. A clamped no-op retains imported precision. */
export function nudgeGraphBand(
  band: Band,
  key: string,
  shift: boolean,
): Band | null {
  const step = shift ? 1 : 0.1;
  const ratio = 2 ** (shift ? 1 : 1 / 12);
  let next: Band;
  switch (key) {
    case "ArrowUp":
      next = {
        ...band,
        gain: normalizeBand({ ...band, gain: band.gain + step }).gain,
      };
      break;
    case "ArrowDown":
      next = {
        ...band,
        gain: normalizeBand({ ...band, gain: band.gain - step }).gain,
      };
      break;
    case "ArrowLeft":
      next = {
        ...band,
        frequency: normalizeBand({ ...band, frequency: band.frequency / ratio })
          .frequency,
      };
      break;
    case "ArrowRight":
      next = {
        ...band,
        frequency: normalizeBand({ ...band, frequency: band.frequency * ratio })
          .frequency,
      };
      break;
    case "Home":
      next = { ...band, gain: 0 };
      break;
    default:
      return null;
  }
  return sameGraphBand(band, next) ? band : next;
}
