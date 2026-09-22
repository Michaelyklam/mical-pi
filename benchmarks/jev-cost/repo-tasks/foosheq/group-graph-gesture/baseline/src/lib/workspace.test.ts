// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FLAT_PROFILE,
  cloneProfile,
  parseProfile,
  serializeProfile,
  type Profile,
} from "./eq";
import {
  DEFAULT_SETTINGS,
  PRESETS_KEY,
  SETTINGS_KEY,
  WORKSPACE_KEY,
  createHistory,
  historyReducer,
  persistPresets,
  persistWorkspace,
  readPresets,
  readSettings,
  readWorkspace,
  type History,
  type HistoryAction,
} from "./workspace";

import { emptyEditorDocument } from "./editorDocument";

function profile(overrides: Partial<Profile> = {}): Profile {
  return { ...cloneProfile(FLAT_PROFILE), ...overrides };
}

function apply(state: History, ...actions: HistoryAction[]): History {
  return actions.reduce(historyReducer, state);
}

function envelope(value = profile()) {
  return { version: 1, profile: value };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    key: vi.fn((index: number) => [...values.keys()][index] ?? null),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  } satisfies Storage;
}

let storage: ReturnType<typeof memoryStorage>;

beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("history snapshots and individual edits", () => {
  it("starts with detached profile and band snapshots and empty history", () => {
    const input = profile();
    const state = createHistory(input);
    expect(state).toEqual({
      past: [],
      present: input,
      future: [],
      checkpoint: null,
    });
    expect(state.present).not.toBe(input);
    expect(state.present.bands).not.toBe(input.bands);
    state.present.bands.forEach((band, index) =>
      expect(band).not.toBe(input.bands[index]),
    );
    input.name = "Changed outside history";
    input.bands[0]!.gain = 5;
    expect(state.present).toEqual(FLAT_PROFILE);
  });

  it("copies set inputs and does not mutate the previous state", () => {
    const state = createHistory(profile());
    state.present.bands.forEach(Object.freeze);
    Object.freeze(state.present.bands);
    Object.freeze(state.present);
    Object.freeze(state.past);
    Object.freeze(state.future);
    Object.freeze(state);
    const input = profile({ preamp: -3 });
    const next = historyReducer(state, { type: "set", profile: input });
    expect(next.past).toEqual([FLAT_PROFILE]);
    expect(next.present).toEqual(input);
    expect(next.present).not.toBe(input);
    expect(next.present.bands[0]).not.toBe(input.bands[0]);
    input.bands[0]!.gain = 8;
    input.preamp = -8;
    expect(next.present.preamp).toBe(-3);
    expect(next.present.bands[0]!.gain).toBe(0);
    expect(state).toEqual(createHistory(FLAT_PROFILE));
  });

  it.each([
    { name: "Renamed" },
    { description: "New description" },
    { preamp: -1 },
    { bands: profile().bands.map((band) => ({ ...band, enabled: false })) },
  ])("records an edit to the same profile ID: %j", (change) => {
    const initial = createHistory(profile());
    const replacement = profile(change);
    const state = historyReducer(initial, {
      type: "set",
      profile: replacement,
    });
    expect(state.present).toEqual(replacement);
    expect(state.past).toEqual([initial.present]);
    expect(state.future).toEqual([]);
    expect(historyReducer(state, { type: "undo" }).present).toEqual(
      initial.present,
    );
  });

  it("treats equal content and the same ID as a no-op, including reordered bands", () => {
    const initial = createHistory(profile());
    const state = apply(
      initial,
      { type: "set", profile: profile({ preamp: -1 }) },
      { type: "undo" },
    );
    const replacement = profile({ bands: profile().bands.reverse() });
    expect(historyReducer(state, { type: "set", profile: replacement })).toBe(
      state,
    );
    expect(state.future).toHaveLength(1);
  });

  it("records replacement by a different ID even when all content is equal", () => {
    const original = profile();
    const replacement = profile({ id: "another-profile" });
    const state = historyReducer(createHistory(original), {
      type: "set",
      profile: replacement,
    });
    expect(state.present).toEqual(replacement);
    expect(state.past).toEqual([original]);
    const undone = historyReducer(state, { type: "undo" });
    expect(undone.present).toEqual(original);
    expect(historyReducer(undone, { type: "redo" }).present).toEqual(
      replacement,
    );
  });

  it("keeps consecutive ungrouped edits as separate undo steps", () => {
    const original = profile();
    const first = profile({ preamp: -1 });
    const second = profile({ preamp: -2 });
    const state = apply(
      createHistory(original),
      { type: "set", profile: first },
      { type: "set", profile: second },
    );
    expect(state.past).toEqual([original, first]);
    expect(historyReducer(state, { type: "undo" }).present).toEqual(first);
  });
});

describe("history transactions", () => {
  it("groups multiple changes into one undo step and clones the checkpoint", () => {
    const original = profile();
    const begun = historyReducer(createHistory(original), { type: "begin" });
    expect(begun.checkpoint).toEqual(original);
    expect(begun.checkpoint).not.toBe(begun.present);
    expect(begun.checkpoint!.bands[0]).not.toBe(begun.present.bands[0]);
    const moving = apply(
      begun,
      { type: "set", profile: profile({ preamp: -1 }) },
      { type: "set", profile: profile({ preamp: -2 }) },
      { type: "set", profile: profile({ preamp: -3 }) },
    );
    expect(moving.past).toEqual([]);
    expect(moving.checkpoint).toBe(begun.checkpoint);
    const settled = historyReducer(moving, { type: "end" });
    expect(settled.checkpoint).toBeNull();
    expect(settled.past).toEqual([original]);
    expect(settled.present.preamp).toBe(-3);
    const undone = historyReducer(settled, { type: "undo" });
    expect(undone.present).toEqual(original);
    expect(historyReducer(undone, { type: "redo" }).present).toEqual(
      settled.present,
    );
  });

  it("does not replace an active checkpoint when begin repeats", () => {
    const original = profile();
    const moving = apply(
      createHistory(original),
      { type: "begin" },
      { type: "set", profile: profile({ preamp: -1 }) },
    );
    expect(historyReducer(moving, { type: "begin" })).toBe(moving);
    const settled = apply(
      moving,
      { type: "begin" },
      { type: "set", profile: profile({ preamp: -2 }) },
      { type: "end" },
    );
    expect(settled.past).toEqual([original]);
  });

  it("ignores end without a transaction, including a repeated end", () => {
    const state = createHistory(profile());
    expect(historyReducer(state, { type: "end" })).toBe(state);
    const settled = apply(
      state,
      { type: "begin" },
      { type: "set", profile: profile({ preamp: -1 }) },
      { type: "end" },
    );
    expect(historyReducer(settled, { type: "end" })).toBe(settled);
  });

  it("does not add undo history or discard redo for an untouched transaction", () => {
    const state = apply(
      createHistory(profile()),
      { type: "set", profile: profile({ preamp: -1 }) },
      { type: "undo" },
    );
    const settled = apply(
      state,
      { type: "begin" },
      { type: "set", profile: cloneProfile(state.present) },
      { type: "end" },
    );
    expect(settled).toEqual(state);
    expect(settled.past).toBe(state.past);
    expect(settled.future).toBe(state.future);
  });

  it("does not add an undo step when changes return to the checkpoint", () => {
    const original = profile();
    const state = apply(
      createHistory(original),
      { type: "begin" },
      { type: "set", profile: profile({ preamp: -1 }) },
      { type: "set", profile: original },
      { type: "end" },
    );
    expect(state).toEqual(createHistory(original));
  });

  // Regressions: these assert the same identity/no-op semantics as ungrouped edits.
  it("records an ID-only replacement inside a transaction", () => {
    const original = profile();
    const replacement = profile({ id: "another-profile" });
    const state = apply(
      createHistory(original),
      { type: "begin" },
      { type: "set", profile: replacement },
      { type: "end" },
    );
    expect(state.past).toEqual([original]);
    expect(state.present).toEqual(replacement);
    expect(historyReducer(state, { type: "undo" }).present).toEqual(original);
  });

  it("preserves redo when a transaction changes values and returns to its checkpoint", () => {
    const original = profile();
    const redoTarget = profile({ preamp: -1 });
    const undone = apply(
      createHistory(original),
      { type: "set", profile: redoTarget },
      { type: "undo" },
    );
    const settled = apply(
      undone,
      { type: "begin" },
      { type: "set", profile: profile({ preamp: -2 }) },
      { type: "set", profile: original },
      { type: "end" },
    );
    expect(settled.past).toEqual([]);
    expect(settled.future).toEqual([redoTarget]);
    expect(historyReducer(settled, { type: "redo" }).present).toEqual(
      redoTarget,
    );
  });

  it("discards the old redo branch when a transaction commits a real change", () => {
    const undone = apply(
      createHistory(profile()),
      { type: "set", profile: profile({ preamp: -1 }) },
      { type: "undo" },
    );
    const settled = apply(
      undone,
      { type: "begin" },
      { type: "set", profile: profile({ preamp: -2 }) },
      { type: "end" },
    );
    expect(settled.future).toEqual([]);
    expect(settled.past).toEqual([FLAT_PROFILE]);
    expect(settled.present.preamp).toBe(-2);
  });
});

describe("undo and redo", () => {
  it("replays multiple edits in order and makes exhausted operations no-ops", () => {
    const original = profile();
    const first = profile({ preamp: -1 });
    const second = profile({ preamp: -2 });
    const initial = createHistory(original);
    expect(historyReducer(initial, { type: "undo" })).toBe(initial);
    expect(historyReducer(initial, { type: "redo" })).toBe(initial);
    const edited = apply(
      initial,
      { type: "set", profile: first },
      { type: "set", profile: second },
    );
    const once = historyReducer(edited, { type: "undo" });
    expect(once).toEqual({
      past: [original],
      present: first,
      future: [second],
      checkpoint: null,
    });
    const twice = historyReducer(once, { type: "undo" });
    expect(twice).toEqual({
      past: [],
      present: original,
      future: [first, second],
      checkpoint: null,
    });
    expect(historyReducer(twice, { type: "undo" })).toBe(twice);
    const redone = historyReducer(twice, { type: "redo" });
    expect(redone).toEqual(once);
    const complete = historyReducer(redone, { type: "redo" });
    expect(complete).toEqual(edited);
    expect(historyReducer(complete, { type: "redo" })).toBe(complete);
  });

  it("clears redo when an ungrouped edit branches from an undone state", () => {
    const undone = apply(
      createHistory(profile()),
      { type: "set", profile: profile({ preamp: -1 }) },
      { type: "undo" },
    );
    const branched = historyReducer(undone, {
      type: "set",
      profile: profile({ preamp: -2 }),
    });
    expect(branched.future).toEqual([]);
    expect(historyReducer(branched, { type: "redo" })).toBe(branched);
  });

  it("settles and undoes an active changed transaction without requiring end", () => {
    const original = profile();
    const changed = profile({ preamp: -3 });
    const moving = apply(
      createHistory(original),
      { type: "begin" },
      { type: "set", profile: profile({ preamp: -1 }) },
      { type: "set", profile: changed },
    );
    const undone = historyReducer(moving, { type: "undo" });
    expect(undone).toEqual({
      past: [],
      present: original,
      future: [changed],
      checkpoint: null,
    });
    expect(historyReducer(undone, { type: "redo" }).present).toEqual(changed);
  });

  it("undoes the previous edit after settling an untouched transaction", () => {
    const original = profile();
    const changed = profile({ preamp: -1 });
    const state = apply(
      createHistory(original),
      { type: "set", profile: changed },
      { type: "begin" },
      { type: "undo" },
    );
    expect(state).toEqual({
      past: [],
      present: original,
      future: [changed],
      checkpoint: null,
    });
  });

  it("can redo through an untouched open transaction", () => {
    const changed = profile({ preamp: -1 });
    const state = apply(
      createHistory(profile()),
      { type: "set", profile: changed },
      { type: "undo" },
      { type: "begin" },
      { type: "redo" },
    );
    expect(state).toEqual({
      past: [FLAT_PROFILE],
      present: changed,
      future: [],
      checkpoint: null,
    });
  });

  it("redo settles a changed transaction instead of applying the stale redo branch", () => {
    const changed = profile({ preamp: -2 });
    const state = apply(
      createHistory(profile()),
      { type: "set", profile: profile({ preamp: -1 }) },
      { type: "undo" },
      { type: "begin" },
      { type: "set", profile: changed },
      { type: "redo" },
    );
    expect(state).toEqual({
      past: [FLAT_PROFILE],
      present: changed,
      future: [],
      checkpoint: null,
    });
  });

  it.each(["undo", "redo"] as const)(
    "%s closes an empty transaction even without history",
    (type) => {
      const state = apply(
        createHistory(profile()),
        { type: "begin" },
        { type },
      );
      expect(state).toEqual(createHistory(FLAT_PROFILE));
    },
  );
});

describe("80-entry history limit", () => {
  it.each([false, true])(
    "retains only the newest 80 edits (grouped=%s), including undo/redo round trips",
    (grouped) => {
      const revisions = Array.from({ length: 101 }, (_, index) =>
        profile({ name: `Revision ${index}` }),
      );
      let state = createHistory(revisions[0]!);
      for (const next of revisions.slice(1)) {
        if (grouped) state = historyReducer(state, { type: "begin" });
        state = historyReducer(state, { type: "set", profile: next });
        if (grouped) state = historyReducer(state, { type: "end" });
        expect(state.past.length).toBeLessThanOrEqual(80);
      }
      expect(state.past).toEqual(revisions.slice(20, 100));
      expect(state.present).toEqual(revisions[100]);
      for (let index = 0; index < 80; index += 1)
        state = historyReducer(state, { type: "undo" });
      expect(state.present).toEqual(revisions[20]);
      expect(state.future).toEqual(revisions.slice(21));
      expect(historyReducer(state, { type: "undo" })).toBe(state);
      for (let index = 0; index < 80; index += 1) {
        state = historyReducer(state, { type: "redo" });
        expect(state.past.length).toBeLessThanOrEqual(80);
      }
      expect(state.past).toEqual(revisions.slice(20, 100));
      expect(state.present).toEqual(revisions[100]);
      expect(state.future).toEqual([]);
    },
  );

  it("also caps past when redo is given an already-full history", () => {
    const past = Array.from({ length: 80 }, (_, index) =>
      profile({ name: `Revision ${index}` }),
    );
    const present = profile({ name: "Revision 80" });
    const future = profile({ name: "Revision 81" });
    const state = historyReducer(
      { past, present, future: [future], checkpoint: null },
      { type: "redo" },
    );
    expect(state.past).toEqual([...past.slice(1), present]);
    expect(state.past).toHaveLength(80);
    expect(state.present).toEqual(future);
  });
});

describe("workspace storage", () => {
  it("uses separate versioned storage keys", () => {
    expect([WORKSPACE_KEY, PRESETS_KEY, SETTINGS_KEY]).toEqual([
      "foosh.workspace.v1",
      "foosh.presets.v1",
      "foosh.settings.v1",
    ]);
  });

  it("loads a valid versioned draft without changing its ID or numeric precision", () => {
    const value = profile({ id: "draft", name: "My draft", preamp: -2.345 });
    value.bands[0] = {
      ...value.bands[0]!,
      frequency: 123.45,
      gain: 1.234,
      q: 0.876,
      enabled: false,
    };
    storage.setItem(WORKSPACE_KEY, serializeProfile(value));
    const loaded = readWorkspace();
    expect(storage.getItem).toHaveBeenCalledWith(WORKSPACE_KEY);
    expect(loaded).toEqual(value);
    loaded.bands[0]!.gain = 9;
    expect(readWorkspace()).toEqual(value);
  });

  it.each([
    null,
    "",
    "{",
    "null",
    "[]",
    "true",
    "{}",
    JSON.stringify(FLAT_PROFILE),
    JSON.stringify({ version: 2, profile: FLAT_PROFILE }),
    JSON.stringify(envelope(profile({ preamp: 1 }))),
    JSON.stringify(envelope(profile({ bands: [] }))),
  ])(
    "returns a fresh empty flat editor for a missing or corrupt draft: %j",
    (text) => {
      if (text !== null) storage.setItem(WORKSPACE_KEY, text);
      const first = readWorkspace();
      expect(first).toEqual(emptyEditorDocument());
      expect(first.bands[0]).not.toBe(FLAT_PROFILE.bands[0]);
      first.name = "Changed fallback";
      first.bands[0]!.gain = 9;
      expect(readWorkspace()).toEqual(emptyEditorDocument());
      expect(storage.getItem(WORKSPACE_KEY)).toBe(text);
    },
  );

  it("persists a validated envelope and leaves unrelated keys alone", () => {
    const value = profile({ id: "draft", preamp: -1 });
    storage.setItem(PRESETS_KEY, "existing library");
    storage.setItem(SETTINGS_KEY, "existing settings");
    expect(persistWorkspace(value)).toBe(true);
    expect(parseProfile(storage.getItem(WORKSPACE_KEY)!)).toEqual(value);
    expect(JSON.parse(storage.getItem(WORKSPACE_KEY)!)).toEqual(
      envelope(value),
    );
    expect(storage.getItem(PRESETS_KEY)).toBe("existing library");
    expect(storage.getItem(SETTINGS_KEY)).toBe("existing settings");
  });

  it.each([NaN, Infinity, -Infinity, -20.1, 0.1])(
    "rejects invalid preamp %s without overwriting a valid draft",
    (preamp) => {
      const original = serializeProfile(FLAT_PROFILE);
      storage.setItem(WORKSPACE_KEY, original);
      storage.setItem.mockClear();
      expect(persistWorkspace(profile({ preamp }))).toBe(false);
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(storage.getItem(WORKSPACE_KEY)).toBe(original);
    },
  );
});

describe("preset library storage", () => {
  it.each([null, "", "{", "null", "{}", "true", "42", '"presets"'])(
    "returns an empty library for missing or corrupt storage: %j",
    (text) => {
      if (text !== null) storage.setItem(PRESETS_KEY, text);
      expect(readPresets()).toEqual([]);
    },
  );

  it("round-trips versioned presets in order, including an empty library", () => {
    const values = [
      profile({ id: "one", preamp: -1 }),
      profile({ id: "two", preamp: -2 }),
    ];
    expect(persistPresets(values)).toBe(true);
    expect(JSON.parse(storage.getItem(PRESETS_KEY)!)).toEqual(
      values.map(envelope),
    );
    const loaded = readPresets();
    expect(loaded).toEqual(values);
    loaded[0]!.bands[0]!.gain = 9;
    expect(readPresets()).toEqual(values);
    expect(persistPresets([])).toBe(true);
    expect(storage.getItem(PRESETS_KEY)).toBe("[]");
    expect(readPresets()).toEqual([]);
  });

  it("filters malformed entries individually without losing later valid profiles", () => {
    const first = profile({ id: "first" });
    const last = profile({ id: "last", preamp: -3 });
    const duplicateBands = profile({ id: "bad-bands" });
    duplicateBands.bands[7]!.id = 1;
    storage.setItem(
      PRESETS_KEY,
      JSON.stringify([
        null,
        {},
        [],
        "not an envelope",
        FLAT_PROFILE,
        { version: 2, profile: FLAT_PROFILE },
        envelope(first),
        envelope(profile({ preamp: -21 })),
        envelope(duplicateBands),
        envelope(last),
      ]),
    );
    expect(readPresets()).toEqual([first, last]);
  });

  it("keeps the first valid occurrence of each ID, not each name", () => {
    const invalid = envelope(profile({ id: "same", preamp: 1 }));
    const first = profile({ id: "same", name: "Same name", preamp: -1 });
    const duplicate = profile({ id: "same", name: "Replacement", preamp: -2 });
    const distinct = profile({ id: "distinct", name: "Same name", preamp: -3 });
    storage.setItem(
      PRESETS_KEY,
      JSON.stringify([
        invalid,
        envelope(first),
        envelope(duplicate),
        envelope(distinct),
      ]),
    );
    expect(readPresets()).toEqual([first, distinct]);
  });

  it("loads at most the first 100 entries", () => {
    const values = Array.from({ length: 105 }, (_, index) =>
      profile({ id: `preset-${index}` }),
    );
    storage.setItem(PRESETS_KEY, JSON.stringify(values.map(envelope)));
    expect(readPresets()).toEqual(values.slice(0, 100));
  });

  it("applies the 100-entry scan bound before filtering invalid and duplicate entries", () => {
    const first = profile({ id: "first" });
    const ignored = profile({ id: "entry-101" });
    storage.setItem(
      PRESETS_KEY,
      JSON.stringify([
        envelope(first),
        ...Array.from({ length: 98 }, () => null),
        envelope(first),
        envelope(ignored),
      ]),
    );
    expect(readPresets()).toEqual([first]);
  });

  it("validates the whole batch before replacing stored presets", () => {
    const original = [profile({ id: "existing" })];
    expect(persistPresets(original)).toBe(true);
    storage.setItem.mockClear();
    const invalid = profile({ id: "invalid" });
    invalid.bands[0]!.gain = NaN;
    expect(persistPresets([profile({ id: "valid" }), invalid])).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(readPresets()).toEqual(original);
  });
});

describe("unavailable browser storage", () => {
  it.each(["missing", "methods throw", "getter throws"] as const)(
    "recovers when localStorage is %s",
    (mode) => {
      if (mode === "missing") vi.stubGlobal("localStorage", undefined);
      if (mode === "methods throw") {
        storage.getItem.mockImplementation(() => {
          throw new Error("Storage access denied");
        });
        storage.setItem.mockImplementation(() => {
          throw new Error("Storage access denied");
        });
      }
      if (mode === "getter throws") {
        // stubGlobal above registered the original descriptor for afterEach to restore.
        Object.defineProperty(globalThis, "localStorage", {
          configurable: true,
          get() {
            throw new Error("Storage access denied");
          },
        });
      }
      expect(readWorkspace()).toEqual(emptyEditorDocument());
      expect(readPresets()).toEqual([]);
      expect(readSettings()).toEqual(DEFAULT_SETTINGS);
      expect(persistWorkspace(profile())).toBe(false);
      expect(persistPresets([profile()])).toBe(false);
      expect(persistPresets([])).toBe(false);
    },
  );

  it("reports quota failures without losing the last successfully saved draft or library", () => {
    const original = profile({ id: "original" });
    expect(persistWorkspace(original)).toBe(true);
    expect(persistPresets([original])).toBe(true);
    storage.setItem.mockImplementation(() => {
      throw new DOMException("Storage full", "QuotaExceededError");
    });
    expect(persistWorkspace(profile({ id: "new" }))).toBe(false);
    expect(persistPresets([])).toBe(false);
    expect(readWorkspace()).toEqual(original);
    expect(readPresets()).toEqual([original]);
  });
});

describe("settings sanity", () => {
  it("defines conservative defaults", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      theme: "system",
      reduceTransparency: false,
      showBandCurves: true,
    });
  });

  it.each([null, "", "{", "null", "[]", "{}", "true", "42", '"dark"'])(
    "uses defaults for absent, corrupt, or non-object settings: %j",
    (text) => {
      if (text !== null) storage.setItem(SETTINGS_KEY, text);
      expect(readSettings()).toEqual(DEFAULT_SETTINGS);
    },
  );

  it.each(["system", "light", "dark"])(
    "accepts theme %s and explicit boolean preferences",
    (theme) => {
      storage.setItem(
        SETTINGS_KEY,
        JSON.stringify({
          theme,
          reduceTransparency: true,
          showBandCurves: false,
        }),
      );
      expect(readSettings()).toEqual({
        theme,
        reduceTransparency: true,
        showBandCurves: false,
      });
      expect(storage.getItem).toHaveBeenCalledWith(SETTINGS_KEY);
    },
  );

  it.each([undefined, null, "", "Dark", "auto", 1, true, [], {}])(
    "falls back only for invalid theme %j",
    (theme) => {
      storage.setItem(
        SETTINGS_KEY,
        JSON.stringify({
          theme,
          reduceTransparency: true,
          showBandCurves: false,
        }),
      );
      expect(readSettings()).toEqual({
        theme: "system",
        reduceTransparency: true,
        showBandCurves: false,
      });
    },
  );

  it.each([undefined, null, "true", "false", 0, 1, [], {}])(
    "does not coerce non-boolean preferences: %j",
    (value) => {
      storage.setItem(
        SETTINGS_KEY,
        JSON.stringify({
          theme: "dark",
          reduceTransparency: value,
          showBandCurves: value,
        }),
      );
      expect(readSettings()).toEqual({
        theme: "dark",
        reduceTransparency: false,
        showBandCurves: true,
      });
    },
  );

  it("reads preferences independently and discards unknown fields", () => {
    storage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        reduceTransparency: false,
        showBandCurves: true,
        unrelated: "ignored",
      }),
    );
    expect(readSettings()).toEqual(DEFAULT_SETTINGS);
    storage.setItem(SETTINGS_KEY, JSON.stringify({ showBandCurves: false }));
    expect(readSettings()).toEqual({
      ...DEFAULT_SETTINGS,
      showBandCurves: false,
    });
    storage.setItem(SETTINGS_KEY, JSON.stringify({ theme: "light" }));
    expect(readSettings()).toEqual({ ...DEFAULT_SETTINGS, theme: "light" });
  });

  it("does not persist or delete anything while reading settings", () => {
    storage.setItem(SETTINGS_KEY, "{");
    storage.setItem.mockClear();
    expect(readSettings()).toEqual(DEFAULT_SETTINGS);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(storage.clear).not.toHaveBeenCalled();
    expect(storage.getItem(SETTINGS_KEY)).toBe("{");
  });
});
