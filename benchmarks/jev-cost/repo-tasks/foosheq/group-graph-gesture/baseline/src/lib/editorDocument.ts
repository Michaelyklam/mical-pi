import {
  FLAT_PROFILE,
  cloneProfile,
  normalizeBand,
  parseProfile,
  profilesEqual,
  serializeProfile,
  type Profile,
} from "./eq";

/** Slot membership is independent of bypass. Missing metadata means a legacy
 * eight-slot profile, never an invitation to discard disabled filters. */
export type EditorProfile = Profile & { visibleBandIds?: number[] };
export type EditorDocument = EditorProfile & { visibleBandIds: number[] };

export function visibleBandIds(profile: EditorProfile): number[] {
  const ids = profile.visibleBandIds ?? profile.bands.map((band) => band.id);
  return [
    ...new Set([
      ...ids,
      ...profile.bands.filter((band) => band.enabled).map((band) => band.id),
    ]),
  ]
    .filter((id) => profile.bands.some((band) => band.id === id))
    .sort((a, b) => a - b);
}

export function editorDocument(profile: EditorProfile): EditorDocument {
  return { ...cloneProfile(profile), visibleBandIds: visibleBandIds(profile) };
}

export function cloneEditorProfile(profile: EditorProfile): EditorProfile {
  return {
    ...cloneProfile(profile),
    ...(profile.visibleBandIds
      ? { visibleBandIds: visibleBandIds(profile) }
      : {}),
  };
}

export function editorProfilesEqual(
  a: EditorProfile,
  b: EditorProfile,
): boolean {
  return (
    a.id === b.id &&
    profilesEqual(a, b) &&
    visibleBandIds(a).join(",") === visibleBandIds(b).join(",")
  );
}

export function emptyEditorDocument(): EditorDocument {
  return {
    ...cloneProfile(FLAT_PROFILE),
    bands: FLAT_PROFILE.bands.map((band) => ({ ...band, enabled: false })),
    visibleBandIds: [],
  };
}

export function addEditorBand(
  profile: EditorProfile,
  frequency: number,
): EditorProfile {
  const ids = visibleBandIds(profile);
  const slot = profile.bands.find((band) => !ids.includes(band.id));
  if (!slot) return profile;
  return {
    ...profile,
    visibleBandIds: [...ids, slot.id].sort((a, b) => a - b),
    bands: profile.bands.map((band) =>
      band.id === slot.id
        ? normalizeBand({ ...band, frequency, gain: -3, q: 2, enabled: true })
        : band,
    ),
  };
}

export function removeEditorBand(
  profile: EditorProfile,
  id: number,
): EditorProfile {
  const ids = visibleBandIds(profile);
  if (!ids.includes(id)) return profile;
  return {
    ...profile,
    visibleBandIds: ids.filter((candidate) => candidate !== id),
    // Keep eight hardware slots, but a removed slot must contribute no response.
    bands: profile.bands.map((band) =>
      band.id === id ? { ...band, enabled: false, gain: 0 } : band,
    ),
  };
}

/** A compatible v1 profile envelope with optional, versioned editor metadata.
 * Existing hardware/import readers ignore the extra field and still see 8 bands. */
export function serializeEditorProfile(profile: EditorProfile): string {
  const envelope = JSON.parse(serializeProfile(profile));
  if (profile.visibleBandIds !== undefined) {
    envelope.editor = { version: 1, visibleBandIds: visibleBandIds(profile) };
  }
  return JSON.stringify(envelope, null, 2);
}

export function parseEditorProfile(text: string): EditorProfile {
  const profile = parseProfile(text);
  const editor = JSON.parse(text).editor;
  if (
    !editor ||
    editor.version !== 1 ||
    !Array.isArray(editor.visibleBandIds) ||
    !editor.visibleBandIds.every(
      (id: unknown) =>
        Number.isInteger(id) && Number(id) >= 1 && Number(id) <= 8,
    ) ||
    new Set(editor.visibleBandIds).size !== editor.visibleBandIds.length
  ) {
    return profile;
  }
  return {
    ...profile,
    visibleBandIds: visibleBandIds({
      ...profile,
      visibleBandIds: editor.visibleBandIds,
    }),
  };
}
