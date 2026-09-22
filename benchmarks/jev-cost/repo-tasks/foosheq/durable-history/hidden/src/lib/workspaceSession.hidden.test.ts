import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const sessions: any = await import("./workspaceSession").catch(() => ({}));
import * as documents from "./editorDocument";
import { createHistory, historyReducer, WORKSPACE_KEY } from "./workspace";
import { FLAT_PROFILE, cloneProfile, serializeProfile } from "./eq";

const { parseHistory, serializeHistory, readHistory, persistHistory } = sessions;
const { emptyEditorDocument, addEditorBand, serializeEditorProfile } = documents;
const p = (name = "Draft") => ({ ...cloneProfile(FLAT_PROFILE), name });
const envelope = (profile = p()) => JSON.parse(serializeEditorProfile(profile));
const session = (changes: any = {}) => ({ version: 1, history: { past: [], present: envelope(), future: [], ...changes } });
function store(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return { values, getItem: vi.fn((key: string) => values.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { values.set(key, value); }) };
}
beforeEach(() => {
  for (const fn of [parseHistory, serializeHistory, readHistory, persistHistory, documents.parseEditorProfileStrict]) expect(fn).toBeTypeOf("function");
});
afterEach(() => vi.unstubAllGlobals());

describe("cancel and committed-session semantics", () => {
  it("cancel preserves a redo branch and detaches the checkpoint", () => {
    let before = historyReducer(createHistory(p()), { type: "set", profile: p("Redo target") });
    before = historyReducer(before, { type: "undo" });
    let draft = historyReducer(before, { type: "begin" });
    draft = historyReducer(draft, { type: "set", profile: addEditorBand(emptyEditorDocument(), 3456) });
    const cancelled = historyReducer(draft, { type: "cancel" } as any);
    expect(cancelled).toEqual(before);
    expect(cancelled.present).not.toBe(draft.checkpoint);
    expect(cancelled.present.bands[0]).not.toBe(draft.checkpoint!.bands[0]);
    expect(cancelled.past).toBe(before.past);
    expect(cancelled.future).toBe(before.future);
    expect(historyReducer(cancelled, { type: "cancel" } as any)).toBe(cancelled);
    expect(historyReducer(cancelled, { type: "redo" }).present.name).toBe("Redo target");
  });

  it("persists the checkpoint, not an in-flight drag; original state stays open", () => {
    const initial = { ...addEditorBand(emptyEditorDocument(), 987), name: "Before" };
    initial.bands[0] = { ...initial.bands[0], enabled: false, gain: -3.50390625, q: 193 / 256 };
    let history = createHistory(initial);
    history = historyReducer(history, { type: "set", profile: { ...initial, name: "Redo" } });
    history = historyReducer(history, { type: "undo" });
    const before = history;
    history = historyReducer(history, { type: "begin" });
    history = historyReducer(history, { type: "set", profile: { ...initial, name: "Transient" } });
    const original = structuredClone(history);
    const text = serializeHistory(history);
    const loaded = parseHistory(text);
    expect(loaded).toEqual(before);
    expect(loaded.present.visibleBandIds).toEqual([1]);
    expect(loaded.present.bands[0].gain).toBe(-3.50390625);
    expect(JSON.parse(text).history).not.toHaveProperty("checkpoint");
    expect(JSON.parse(text).history.present.profile.name).toBe("Before");
    expect(history).toEqual(original);
    expect(history.checkpoint).not.toBeNull();
  });

  it("round-trips history order through undo, redo, membership changes and identity changes", () => {
    let history = createHistory(emptyEditorDocument());
    const expected = [history.present];
    for (let index = 0; index < 12; index++) {
      const profile = { ...addEditorBand(history.present, 1000 + index), id: `identity-${index}`, preamp: -(index + 1) / 8 };
      history = historyReducer(history, { type: "set", profile });
      expected.push(profile);
    }
    for (let index = 0; index < 4; index++) history = historyReducer(history, { type: "undo" });
    let restored = parseHistory(serializeHistory(history));
    expect(restored).toEqual(history);
    for (let index = 9; index <= 12; index++) {
      restored = historyReducer(restored, { type: "redo" });
      expect(restored.present).toEqual(expected[index]);
    }
    restored.present.bands[0].gain = 9;
    expect(history.future.at(-1)!.bands[0].gain).toBe(-3);
  });
});

describe("strict session boundary, tolerant legacy boundary", () => {
  it.each([null, [], {}, { version: 2, visibleBandIds: [] }, { version: 1, visibleBandIds: [2, 2] }, { version: 1, visibleBandIds: [0] }, { version: 1, visibleBandIds: [9] }, { version: 1, visibleBandIds: [1.5] }, { version: 1, visibleBandIds: ["1"] }].map(editor => ({ editor })))("rejects invalid metadata without changing tolerant imports: %j", ({ editor }) => {
    const text = JSON.stringify({ ...envelope(), editor });
    expect(documents.parseEditorProfile(text)).toEqual(p());
    expect(() => documents.parseEditorProfileStrict(text)).toThrow();
    expect(() => parseHistory(JSON.stringify(session({ past: [JSON.parse(text)] })))).toThrow();
  });
  it("normalizes valid membership but retains legacy disabled slots", () => {
    const profile = emptyEditorDocument();
    profile.bands[2].enabled = true;
    const text = JSON.stringify({ version: 1, profile, editor: { version: 1, visibleBandIds: [5, 1], extra: true } });
    expect(documents.parseEditorProfileStrict(text).visibleBandIds).toEqual([1, 3, 5]);
    expect(documents.parseEditorProfileStrict(serializeProfile(profile))).not.toHaveProperty("visibleBandIds");
  });
  it.each([
    null, [], {}, { version: 2, history: session().history },
    session({ past: null }), session({ future: {} }), session({ present: null }),
    session({ checkpoint: null }), session({ present: { version: 1, profile: { ...p(), preamp: 1 } } }),
    session({ past: [envelope(), { version: 1, profile: p(), editor: null }] }),
    session({ past: Array(81).fill(envelope()) }),
    session({ future: Array(81).fill(envelope()) }),
    session({ past: Array(40).fill(envelope()), future: Array(41).fill(envelope()) }),
  ].map(value => ({ value })))("rejects the entire malformed session: %#", ({ value }) => {
    expect(() => parseHistory(JSON.stringify(value))).toThrow();
  });
  it("validates the full EQ schema for every history position, not only the current profile", () => {
    const mutations = [
      (v: any) => { v.bands[0].frequency = 20001; },
      (v: any) => { v.bands[0].gain = -10.01; },
      (v: any) => { v.bands[0].q = 10.01; },
      (v: any) => { v.bands[0].enabled = 1; },
      (v: any) => { v.bands[0].type = "lowpass"; },
      (v: any) => { v.bands[1].id = 1; },
      (v: any) => { v.bands.pop(); },
      (v: any) => { v.id = ""; },
    ];
    for (const mutate of mutations) for (const location of ["past", "present", "future"] as const) {
      const bad = p(); mutate(bad);
      const entry = { version: 1, profile: bad };
      expect(() => parseHistory(JSON.stringify(session({ [location]: location === "present" ? entry : [envelope(), entry] })))).toThrow();
      const history = createHistory(p());
      if (location === "present") history.present = bad; else history[location] = [p(), bad];
      const storage = store();
      expect(persistHistory(history, storage)).toBe(false);
      expect(storage.setItem).not.toHaveBeenCalled();
    }
  });
  it("accepts a full 80-step split without deduplicating", () => {
    const value = session({ past: Array(40).fill(envelope()), future: Array(40).fill(envelope()) });
    const loaded = parseHistory(JSON.stringify(value));
    expect(loaded.past).toHaveLength(40);
    expect(loaded.future).toHaveLength(40);
    expect(parseHistory(serializeHistory(loaded))).toEqual(loaded);
    loaded.past[0].bands[0].gain = 3;
    expect(loaded.past[1].bands[0].gain).toBe(0);
  });
  it("measures UTF-8 input, rejects oversized whitespace and projects inert extras", () => {
    const normal = JSON.stringify(session());
    expect(() => parseHistory(" ".repeat(1024 * 1024) + normal)).toThrow();
    const unicode = JSON.stringify({ ...session(), padding: "😀".repeat(270000) });
    expect(unicode.length).toBeLessThan(1024 * 1024);
    expect(() => parseHistory(unicode)).toThrow();
    const loaded = parseHistory(JSON.stringify({ ...session(), extra: { arbitrary: true } }));
    const output = JSON.parse(serializeHistory({ ...loaded, secret: "drop" } as any));
    expect(Object.keys(output).sort()).toEqual(["history", "version"]);
    expect(Object.keys(output.history).sort()).toEqual(["future", "past", "present"]);
  });
  it("rejects sparse stacks and malformed explicit metadata on serialization before touching storage", () => {
    const invalid: any[] = [];
    const sparse = createHistory(p()); sparse.past = new Array(1); invalid.push(sparse);
    const duplicate = createHistory(p()); duplicate.present.visibleBandIds = [1, 1]; invalid.push(duplicate);
    const badCheckpoint = historyReducer(createHistory(emptyEditorDocument()), { type: "begin" });
    badCheckpoint.checkpoint!.visibleBandIds = [9]; invalid.push(badCheckpoint);
    const overfull = createHistory(p()); overfull.past = Array(40).fill(p()); overfull.future = Array(41).fill(p()); invalid.push(overfull);
    for (const history of invalid) {
      const storage = store();
      expect(() => serializeHistory(history)).toThrow();
      expect(persistHistory(history, storage)).toBe(false);
      expect(storage.setItem).not.toHaveBeenCalled();
    }
  });
  it("validates all profiles before writing and rejects nonfinite values", () => {
    for (const field of ["past", "present", "future"] as const) {
      const history = createHistory(p());
      const invalid = p(); invalid.bands[0].q = NaN;
      if (field === "present") history.present = invalid;
      else history[field] = [p(), invalid];
      const storage = store({ "foosh.history.v1": "old bytes" });
      expect(persistHistory(history, storage)).toBe(false);
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(storage.values.get("foosh.history.v1")).toBe("old bytes");
    }
  });
});

describe("storage isolation and recovery", () => {
  it("prefers session; writes only its own key once and does not migrate on read", () => {
    expect(sessions.HISTORY_KEY).toBe("foosh.history.v1");
    const storage = store({ [WORKSPACE_KEY]: serializeProfile(p("Legacy")), "foosh.presets.v1": "keep", "foosh.settings.v1": "keep too" });
    const history = createHistory(addEditorBand(emptyEditorDocument(), 2222));
    expect(persistHistory(history, storage)).toBe(true);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(storage.setItem.mock.calls[0][0]).toBe(sessions.HISTORY_KEY);
    storage.setItem.mockClear();
    expect(readHistory(storage)).toEqual(history);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.values.get(WORKSPACE_KEY)).toBe(serializeProfile(p("Legacy")));
    expect(storage.values.get("foosh.presets.v1")).toBe("keep");
  });
  it.each([null, "{", JSON.stringify(session({ checkpoint: null }))])("falls back from absent/corrupt session, preserving malformed legacy editor compatibility", (text) => {
    const legacy = JSON.stringify({ ...envelope(p("Legacy")), editor: { version: 999 } });
    const storage = store({ [WORKSPACE_KEY]: legacy });
    if (text !== null) storage.values.set(sessions.HISTORY_KEY, text);
    expect(readHistory(storage)).toEqual(createHistory(p("Legacy")));
    expect(storage.setItem).not.toHaveBeenCalled();
  });
  it("recovers independently from session-key read failure and total storage failure", () => {
    const storage = store({ [WORKSPACE_KEY]: serializeProfile(p("Legacy")) });
    storage.getItem.mockImplementation((key) => { if (key === sessions.HISTORY_KEY) throw Error("denied"); return storage.values.get(key) ?? null; });
    expect(readHistory(storage).present.name).toBe("Legacy");
    storage.getItem.mockImplementation(() => { throw Error("denied"); });
    expect(readHistory(storage)).toEqual(createHistory(emptyEditorDocument()));
    storage.setItem.mockImplementation(() => { throw Error("quota"); });
    expect(persistHistory(createHistory(p()), storage)).toBe(false);
    vi.stubGlobal("localStorage", undefined);
    expect(readHistory()).toEqual(createHistory(emptyEditorDocument()));
    expect(persistHistory(createHistory(p()))).toBe(false);
  });
  it("uses injected storage without inspecting a forbidden global getter", () => {
    vi.stubGlobal("localStorage", undefined);
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw Error("must not inspect"); } });
    const storage = store();
    expect(persistHistory(createHistory(p()), storage)).toBe(true);
    expect(readHistory(storage).present.name).toBe("Draft");
  });
});
