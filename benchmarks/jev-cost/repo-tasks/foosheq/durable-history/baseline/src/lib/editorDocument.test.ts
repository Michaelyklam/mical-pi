// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FLAT_PROFILE,
  LIMITS,
  cloneProfile,
  parseProfile,
  profileResponseDb,
  serializeProfile,
} from "./eq";
import {
  addEditorBand,
  cloneEditorProfile,
  emptyEditorDocument,
  editorDocument,
  parseEditorProfile,
  removeEditorBand,
  serializeEditorProfile,
  visibleBandIds,
  type EditorProfile,
} from "./editorDocument";
import {
  createHistory,
  historyReducer,
  persistPresets,
  persistWorkspace,
  readPresets,
  readWorkspace,
  WORKSPACE_KEY,
} from "./workspace";

afterEach(() => vi.unstubAllGlobals());

function storage() {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  return values;
}

describe("editor slot membership", () => {
  it("starts flat with zero visible filters and eight inactive hardware slots", () => {
    const doc = emptyEditorDocument();
    expect(visibleBandIds(doc)).toEqual([]);
    expect(doc.bands).toHaveLength(8);
    expect(doc.bands.every((band) => !band.enabled && band.gain === 0)).toBe(
      true,
    );
    expect(doc.preamp).toBe(0);
    expect(profileResponseDb(doc, 1000)).toBe(0);
    expect(parseProfile(serializeEditorProfile(doc)).bands).toHaveLength(8);
  });

  it("adds at the cursor with -3 dB and Q 2, caps at eight, and reuses removed slots", () => {
    let doc: EditorProfile = emptyEditorDocument();
    for (let count = 1; count <= 8; count++) {
      doc = addEditorBand(doc, 1234);
      expect(visibleBandIds(doc)).toHaveLength(count);
    }
    expect(addEditorBand(doc, 8000)).toBe(doc);
    doc = removeEditorBand(doc, 3);
    expect(visibleBandIds(doc)).toEqual([1, 2, 4, 5, 6, 7, 8]);
    expect(doc.bands[2]).toMatchObject({ enabled: false, gain: 0 });
    doc = addEditorBand(doc, 7654);
    expect(doc.bands[2]).toMatchObject({
      id: 3,
      frequency: 7654,
      gain: -3,
      q: 2,
      enabled: true,
    });
    expect(doc.bands).toHaveLength(8);
  });

  it("does not treat bypassed or zero-gain filters as unused slots", () => {
    const added = addEditorBand(emptyEditorDocument(), 1000);
    const bypassed = {
      ...added,
      bands: added.bands.map((band) => ({ ...band, enabled: false, gain: 0 })),
    };
    expect(visibleBandIds(bypassed)).toEqual([1]);
    const next = addEditorBand(bypassed, 2000);
    expect(visibleBandIds(next)).toEqual([1, 2]);
    expect(next.bands[0]).toMatchObject({ frequency: 1000, enabled: false });
  });

  it("clones membership and keeps original main-editor limits", () => {
    const doc = addEditorBand(emptyEditorDocument(), LIMITS.frequencyMax + 100);
    expect(doc.bands[0]!.frequency).toBe(LIMITS.frequencyMax);
    const copy = cloneEditorProfile(doc);
    copy.visibleBandIds!.push(8);
    expect(doc.visibleBandIds).toEqual([1]);
    const original = cloneProfile(FLAT_PROFILE);
    original.bands[0]!.gain = 9.321;
    original.bands[0]!.q = 9.876;
    expect(parseEditorProfile(serializeProfile(original))).toEqual(original);
  });

  it("undoes and redoes add, bypass and removal as independent edits", () => {
    const empty = emptyEditorDocument();
    let history = createHistory(empty);
    const added = addEditorBand(history.present, 1200);
    history = historyReducer(history, { type: "set", profile: added });
    const bypassed = {
      ...added,
      bands: added.bands.map((band) => ({ ...band, enabled: false })),
    };
    history = historyReducer(history, { type: "set", profile: bypassed });
    history = historyReducer(history, {
      type: "set",
      profile: removeEditorBand(history.present, 1),
    });
    expect(visibleBandIds(history.present)).toEqual([]);
    history = historyReducer(history, { type: "undo" });
    expect(history.present).toEqual(bypassed);
    history = historyReducer(history, { type: "undo" });
    expect(history.present).toEqual(added);
    history = historyReducer(history, { type: "undo" });
    expect(history.present).toEqual(empty);
    for (let count = 0; count < 3; count++)
      history = historyReducer(history, { type: "redo" });
    expect(visibleBandIds(history.present)).toEqual([]);
  });

  it("records visibility-only changes even within a transaction", () => {
    const empty = emptyEditorDocument();
    let history = createHistory(empty);
    history = historyReducer(history, { type: "begin" });
    history = historyReducer(history, {
      type: "set",
      profile: { ...empty, visibleBandIds: [1] },
    });
    history = historyReducer(history, { type: "end" });
    expect(history.past).toHaveLength(1);
    expect(
      visibleBandIds(historyReducer(history, { type: "undo" }).present),
    ).toEqual([]);
    expect(visibleBandIds(history.present)).toEqual([1]);
  });
});

describe("editor metadata persistence and migration", () => {
  it("round-trips membership in workspace, library and compatible exports", () => {
    storage();
    const doc = removeEditorBand(
      addEditorBand(addEditorBand(emptyEditorDocument(), 700), 1700),
      1,
    );
    expect(persistWorkspace(doc)).toBe(true);
    expect(readWorkspace()).toEqual(doc);
    expect(persistPresets([doc])).toBe(true);
    expect(readPresets()).toEqual([doc]);
    const exported = serializeEditorProfile(doc);
    expect(parseEditorProfile(exported)).toEqual(doc);
    expect(parseProfile(exported)).toEqual(cloneProfile(doc));
  });

  it("migrates profile-only workspaces without hiding disabled bands or rounding values", () => {
    const values = storage();
    const legacy = cloneProfile(FLAT_PROFILE);
    legacy.bands[3] = {
      ...legacy.bands[3]!,
      enabled: false,
      gain: -8.321,
      q: 7.123,
    };
    values.set(WORKSPACE_KEY, serializeProfile(legacy));
    const loaded = readWorkspace();
    expect(loaded).toEqual(legacy);
    expect(visibleBandIds(loaded)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // Opening a legacy profile in the editor materializes explicit membership.
    const migrated = editorDocument(loaded);
    expect(migrated.visibleBandIds).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    persistWorkspace(migrated);
    expect(readWorkspace()).toEqual({
      ...legacy,
      visibleBandIds: [1, 2, 3, 4, 5, 6, 7, 8],
    });
  });

  it("never reads, migrates, overwrites or deletes the legacy ear draft", () => {
    const values = storage();
    const legacyEar = '{"user":"precious legacy data"}';
    values.set("foosh.ear-draft.v2", legacyEar);
    expect(readWorkspace()).toEqual(emptyEditorDocument());
    persistWorkspace(addEditorBand(readWorkspace(), 1800));
    expect(values.get("foosh.ear-draft.v2")).toBe(legacyEar);
  });

  it.each([
    null,
    { version: 2, visibleBandIds: [] },
    { version: 1, visibleBandIds: [1, 1] },
    { version: 1, visibleBandIds: [9] },
    { version: 1, visibleBandIds: ["1"] },
  ])(
    "recovers malformed membership without throwing away a valid profile: %j",
    (editor) => {
      const legacy = cloneProfile(FLAT_PROFILE);
      legacy.bands[0]!.enabled = false;
      const parsed = parseEditorProfile(
        JSON.stringify({ version: 1, profile: legacy, editor }),
      );
      expect(parsed).toEqual(legacy);
      expect(visibleBandIds(parsed)).toHaveLength(8);
    },
  );

  it("does not hide an enabled filter when metadata omits its slot", () => {
    const profile = emptyEditorDocument();
    profile.bands[2] = { ...profile.bands[2]!, enabled: true, gain: 8 };
    const parsed = parseEditorProfile(
      JSON.stringify({
        version: 1,
        profile,
        editor: { version: 1, visibleBandIds: [] },
      }),
    );
    expect(visibleBandIds(parsed)).toEqual([3]);
    expect(parsed.bands[2]!.gain).toBe(8);
  });
});
