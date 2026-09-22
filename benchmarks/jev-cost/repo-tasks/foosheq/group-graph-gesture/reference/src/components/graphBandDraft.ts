import { cloneEditorProfile, visibleBandIds, type EditorProfile } from "../lib/editorDocument";
import { clamp, LIMITS, normalizeBand, type Band } from "../lib/eq";

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

export type GraphGesture = {
  base: EditorProfile;
  draft: EditorProfile;
  selectedIds: number[];
};
export type GraphDelta = { octaves?: number; gain?: number; qOctaves?: number };
export type GraphConflict = { id: number; field: "profile" | "membership" | "frequency" | "gain" | "q" };

export function beginGraphGesture(profile: EditorProfile, selectedIds: number[]): GraphGesture {
  const visible = new Set(visibleBandIds(profile));
  return {
    base: cloneEditorProfile(profile),
    draft: cloneEditorProfile(profile),
    selectedIds: [...new Set(selectedIds)].filter((id) => visible.has(id)).sort((a, b) => a - b),
  };
}

export function updateGraphGesture(gesture: GraphGesture, delta: GraphDelta): GraphGesture {
  for (const axis of ["octaves", "gain", "qOctaves"] as const) {
    if (delta[axis] !== undefined && !Number.isFinite(delta[axis])) throw new Error("Graph deltas must be finite.");
  }
  const next = beginGraphGesture(gesture.base, gesture.selectedIds);
  const selected = next.base.bands.filter((band) => next.selectedIds.includes(band.id));
  if (!selected.length) return next;
  const bounded = (requested: number, min: (band: Band) => number, max: (band: Band) => number) =>
    clamp(requested, Math.max(...selected.map(min)), Math.min(...selected.map(max)));
  const octaves = bounded(delta.octaves ?? 0,
    (band) => Math.log2(LIMITS.frequencyMin / band.frequency),
    (band) => Math.log2(LIMITS.frequencyMax / band.frequency));
  const gain = bounded(delta.gain ?? 0,
    (band) => LIMITS.gainMin - band.gain,
    (band) => LIMITS.gainMax - band.gain);
  const qOctaves = bounded(delta.qOctaves ?? 0,
    (band) => Math.log2(LIMITS.qMin / band.q),
    (band) => Math.log2(LIMITS.qMax / band.q));
  next.draft.bands = next.draft.bands.map((band) => {
    if (!next.selectedIds.includes(band.id)) return band;
    const edited = { ...band };
    if (octaves !== 0) edited.frequency = normalizeBand({ ...band, frequency: band.frequency * 2 ** octaves }).frequency;
    if (gain !== 0) edited.gain = normalizeBand({ ...band, gain: band.gain + gain }).gain;
    if (qOctaves !== 0) edited.q = normalizeBand({ ...band, q: band.q * 2 ** qOctaves }).q;
    return edited;
  });
  return next;
}

export function rebaseGraphGesture(profile: EditorProfile, gesture: GraphGesture): { profile: EditorProfile; conflicts: GraphConflict[] } {
  if (profile.id !== gesture.base.id) return { profile, conflicts: [{ id: 0, field: "profile" }] };
  const conflicts: GraphConflict[] = [];
  const visible = new Set(visibleBandIds(profile));
  const replacements = new Map<number, Band>();
  for (const id of gesture.selectedIds) {
    const before = gesture.base.bands.find((band) => band.id === id)!;
    const draft = gesture.draft.bands.find((band) => band.id === id)!;
    const changed = (["frequency", "gain", "q"] as const).filter((field) => before[field] !== draft[field]);
    if (!changed.length) continue;
    const latest = profile.bands.find((band) => band.id === id);
    if (!latest || !visible.has(id)) {
      conflicts.push({ id, field: "membership" });
      continue;
    }
    const next = { ...latest };
    let applied = false;
    for (const field of changed) {
      if (latest[field] === draft[field]) continue;
      if (latest[field] !== before[field]) conflicts.push({ id, field });
      else { next[field] = draft[field]; applied = true; }
    }
    if (applied) replacements.set(id, next);
  }
  conflicts.sort((a, b) => a.id - b.id || (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
  return {
    profile: replacements.size ? { ...profile, bands: profile.bands.map((band) => replacements.get(band.id) ?? band) } : profile,
    conflicts,
  };
}
