import { beforeEach, describe, expect, it } from "vitest";
import * as graph from "./graphBandDraft";
import * as workspace from "../lib/workspace";
import { addEditorBand, emptyEditorDocument, removeEditorBand, parseEditorProfile, serializeEditorProfile } from "../lib/editorDocument";

const { beginGraphGesture: begin, updateGraphGesture: update, rebaseGraphGesture: rebase } = graph;
const { createHistory, historyReducer, commitGraphGesture: commit } = workspace;
beforeEach(() => { for (const fn of [begin, update, rebase, commit]) expect(fn).toBeTypeOf("function"); });
function profile() {
  let p = addEditorBand(addEditorBand(addEditorBand(emptyEditorDocument(), 1000), 4000), 10000);
  p.bands[0] = { ...p.bands[0], gain: 1.234375, q: 0.75390625 };
  p.bands[1] = { ...p.bands[1], gain: 5.234375, q: 2, enabled: false };
  p.bands[2] = { ...p.bands[2], gain: -2, q: 5 };
  return p;
}
function freeze(value: any): any {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
function band(p: any, id: number) { return p.bands.find((b: any) => b.id === id); }

describe("group movement against the original pointerdown document", () => {
  it("selects visible slots, including bypass, and owns detached state", () => {
    const p = profile();
    const gesture = begin(p, [8, 3, 2, 2, 0, 42]);
    expect(gesture.selectedIds).toEqual([2, 3]);
    expect(gesture.base).toEqual(p); expect(gesture.draft).toEqual(p);
    expect(gesture.base).not.toBe(p); expect(gesture.draft).not.toBe(p);
    expect(gesture.base.bands[0]).not.toBe(gesture.draft.bands[0]);
    p.bands[1].frequency = 123;
    expect(gesture.base.bands[1].frequency).toBe(4000);
    expect(gesture.draft.bands[1].frequency).toBe(4000);
    const legacy = { ...p }; delete legacy.visibleBandIds;
    expect(begin(legacy, [8]).selectedIds).toEqual([8]);
  });
  it("clamps the delta as a group, not each band independently", () => {
    const p = profile();
    const gesture = update(begin(p, [1, 2]), { octaves: 20, gain: 30, qOctaves: 20 });
    expect(band(gesture.draft, 1)).toMatchObject({ frequency: 5000, gain: 6, q: 3.77 });
    expect(band(gesture.draft, 2)).toMatchObject({ frequency: 20000, gain: 10, q: 10, enabled: false });
    expect(band(gesture.draft, 3)).toEqual(band(p, 3));
    expect(gesture.draft.visibleBandIds).toEqual([1, 2, 3]);
    const lower = update(begin(p, [1, 2]), { octaves: -100, gain: -100, qOctaves: -100 });
    expect(band(lower.draft, 1)).toMatchObject({ frequency: 20, gain: -10, q: 0.1 });
    expect(band(lower.draft, 2)).toMatchObject({ frequency: 80, gain: -6, q: 0.27 });
  });
  it("recomputes absolute deltas, including returning to exact imported values", () => {
    const p = freeze(profile());
    const start = freeze(begin(p, [1, 2]));
    const moved = freeze(update(start, { octaves: 1, gain: 1, qOctaves: 1 }));
    const second = update(moved, { octaves: 2 });
    expect(band(second.draft, 1).frequency).toBe(4000);
    expect(band(second.draft, 1).gain).toBe(1.234375);
    expect(band(second.draft, 1).q).toBe(0.75390625);
    expect(update(moved, {}).draft).toEqual(p);
    expect(update(moved, { octaves: 0, gain: 0, qOctaves: 0 }).draft).toEqual(p);
  });
  it("effective-zero axes at group limits preserve unrelated precision", () => {
    const p = profile();
    p.bands[1] = { ...p.bands[1], frequency: 20000, gain: 10, q: 10 };
    p.bands[0].frequency = 1234.5678;
    expect(update(begin(p, [1, 2]), { octaves: 1, gain: 1, qOctaves: 1 }).draft).toEqual(p);
    const moved = update(begin(p, [1, 2]), { octaves: -0.5 });
    expect(moved.draft.bands[0].frequency).toBe(873);
    expect(moved.draft.bands[0].gain).toBe(1.234375);
    expect(moved.draft.bands[0].q).toBe(0.75390625);
  });
  it.each([NaN, Infinity, -Infinity])("rejects invalid axes even with no selected bands: %s", (value) => {
    for (const axis of ["octaves", "gain", "qOctaves"]) {
      expect(() => update(begin(profile(), []), { [axis]: value })).toThrow();
      expect(() => update(begin(profile(), [1]), { [axis]: value })).toThrow();
    }
  });
  it("empty selection and finite enormous deltas do not overflow", () => {
    const p = profile();
    expect(update(begin(p, [7]), { octaves: 1000, qOctaves: 1000, gain: 1000 }).draft).toEqual(p);
    const g = update(begin(p, [1, 2, 3]), { octaves: Number.MAX_VALUE, gain: Number.MAX_VALUE, qOctaves: Number.MAX_VALUE });
    expect(g.draft.bands.slice(0, 3).map((b: any) => b.frequency)).toEqual([2000, 8000, 20000]);
    expect(g.draft.bands.slice(0, 3).map((b: any) => b.q)).toEqual([1.51, 4, 10]);
    expect(parseEditorProfile(serializeEditorProfile(g.draft))).toEqual(g.draft);
  });
});

describe("field-level rebase and editor membership", () => {
  it("keeps concurrent metadata, Q, bypass and new slots while applying touched axes by ID", () => {
    const p = profile();
    const gesture = freeze(update(begin(p, [1, 2]), { octaves: 1, gain: 0.5 }));
    let latest = addEditorBand(p, 8888);
    latest = { ...latest, name: "Renamed concurrently", description: "keep", preamp: -8.5, bands: latest.bands.map((b) => b.id === 1 ? { ...b, q: 9.876, enabled: false } : b).reverse() };
    freeze(latest);
    const result = rebase(latest, gesture);
    expect(result.conflicts).toEqual([]);
    expect(result.profile.name).toBe("Renamed concurrently");
    expect(result.profile.preamp).toBe(-8.5);
    expect(result.profile.bands.map((b: any) => b.id)).toEqual(latest.bands.map(b => b.id));
    expect(band(result.profile, 1)).toMatchObject({ frequency: 2000, gain: 1.7, q: 9.876, enabled: false });
    expect(band(result.profile, 2)).toMatchObject({ frequency: 8000, gain: 5.7, enabled: false });
    expect(band(result.profile, 4)).toEqual(band(latest, 4));
    expect(result.profile.visibleBandIds).toEqual([1, 2, 3, 4]);
  });
  it("reports deterministic conflicts but applies each nonconflicting field", () => {
    const p = profile();
    const gesture = update(begin(p, [3, 2, 1]), { octaves: 0.5, gain: -1, qOctaves: -1 });
    let latest = { ...p, bands: p.bands.map(b => ({ ...b })) };
    latest.bands[0].gain = -7;
    latest.bands[0].frequency = 1100;
    latest.bands[1].q = 4;
    latest.bands[2].gain = gesture.draft.bands[2].gain; // same result is not a conflict
    const result = rebase(freeze(latest), freeze(gesture));
    expect(result.conflicts).toEqual([{ id: 1, field: "frequency" }, { id: 1, field: "gain" }, { id: 2, field: "q" }]);
    expect(band(result.profile, 1)).toMatchObject({ frequency: 1100, gain: -7, q: 0.38 });
    expect(band(result.profile, 2)).toMatchObject({ frequency: 5657, gain: 4.2, q: 4 });
    expect(band(result.profile, 3)).toMatchObject({ frequency: 14142, gain: -3, q: 2.5 });
  });
  it("does not resurrect removed slots or overwrite profile replacements", () => {
    const p = profile(); const g = update(begin(p, [1, 2]), { gain: 1 });
    const removed = removeEditorBand(p, 1);
    const r = rebase(removed, g);
    expect(r.conflicts).toEqual([{ id: 1, field: "membership" }]);
    expect(band(r.profile, 1)).toEqual(band(removed, 1));
    expect(band(r.profile, 2).gain).toBe(6.2);
    const missing = { ...p, bands: p.bands.filter(b => b.id !== 2) };
    expect(rebase(missing, g).conflicts).toEqual([{ id: 2, field: "membership" }]);
    const other = { ...p, id: "replacement" };
    expect(rebase(other, g)).toEqual({ profile: other, conflicts: [{ id: 0, field: "profile" }] });
    expect(rebase(other, g).profile).toBe(other);
    expect(rebase(removed, begin(p, [1])).conflicts).toEqual([]); // untouched removal has no conflict
  });
  it("no changes, all-already-applied or all-conflicted edits preserve latest identity", () => {
    const p = profile(); const g = update(begin(p, [1]), { gain: 1 });
    expect(rebase(p, begin(p, [1])).profile).toBe(p);
    expect(rebase(g.draft, g)).toEqual({ profile: g.draft, conflicts: [] });
    expect(rebase(g.draft, g).profile).toBe(g.draft);
    const conflict = { ...p, bands: p.bands.map(b => b.id === 1 ? { ...b, gain: -8 } : b) };
    expect(rebase(conflict, g).profile).toBe(conflict);
    expect(rebase(conflict, g).conflicts).toEqual([{ id: 1, field: "gain" }]);
  });
});

describe("one atomic undo step after concurrent edits", () => {
  it("undo restores the latest state, not stale pointerdown state; redo preserves membership", () => {
    const p = profile(); const g = update(begin(p, [1, 2]), { gain: -2, octaves: 0.5 });
    let h = createHistory(p);
    h = historyReducer(h, { type: "set", profile: { ...addEditorBand(p, 800), name: "New metadata" } });
    const latest = h.present;
    const result = commit(freeze(h), freeze(g));
    expect(result.conflicts).toEqual([]);
    expect(result.history.past).toHaveLength(2);
    expect(result.history.checkpoint).toBeNull();
    expect(result.history.present.name).toBe("New metadata");
    const undone = historyReducer(result.history, { type: "undo" });
    expect(undone.present).toEqual(latest);
    expect(historyReducer(undone, { type: "redo" }).present).toEqual(result.history.present);
    expect(parseEditorProfile(serializeEditorProfile(result.history.present))).toEqual(result.history.present);
  });
  it("no-op commit preserves redo and nested transactions reject without mutation", () => {
    const p = profile();
    const edited = historyReducer(createHistory(p), { type: "set", profile: { ...p, name: "Later" } });
    const undone = historyReducer(edited, { type: "undo" });
    expect(commit(undone, begin(p, [1])).history).toBe(undone);
    expect(commit(undone, begin(p, [1])).history.future).toBe(undone.future);
    const active = freeze(historyReducer(undone, { type: "begin" }));
    expect(() => commit(active, update(begin(p, [1]), { gain: 1 }))).toThrow();
    expect(() => commit(active, begin(p, []))).toThrow();
  });
  it("keeps the 80-entry cap when a large group commits", () => {
    let h = createHistory(profile());
    for (let index = 0; index < 90; index++) h = historyReducer(h, { type: "set", profile: { ...h.present, name: `Revision ${index}` } });
    const g = update(begin(h.present, [1, 2, 3]), { gain: 1 });
    const result = commit(h, g);
    expect(result.history.past).toHaveLength(80);
    expect(result.history.past.at(-1)).toEqual(h.present);
    expect(result.history.future).toEqual([]);
  });
});
