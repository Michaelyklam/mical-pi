import { describe, expect, it } from "vitest";
import { type Band } from "../lib/eq";
import {
  applyBandPreview,
  captureBandPreview,
  nudgeGraphBand,
  sameGraphBand,
} from "./graphBandDraft";

const band = (changes: Partial<Band> = {}): Band => ({
  id: 1,
  type: "peak",
  frequency: 1000,
  gain: 4.321,
  q: 7.123,
  enabled: true,
  ...changes,
});

describe("graph model no-ops", () => {
  it("compares imported precision exactly without normalizing", () => {
    expect(sameGraphBand(band(), { ...band() })).toBe(true);
    expect(sameGraphBand(band(), band({ gain: 4.3 }))).toBe(false);
    expect(sameGraphBand(band(), band({ q: 7.12 }))).toBe(false);
  });

  it.each([
    ["ArrowRight", { frequency: 20000 }],
    ["ArrowLeft", { frequency: 20 }],
    ["ArrowUp", { gain: 10 }],
    ["ArrowDown", { gain: -10 }],
    ["Home", { gain: 0 }],
  ] as const)(
    "%s at its bound preserves the entire band and imported precision",
    (key, changes) => {
      const original = band(changes);
      expect(nudgeGraphBand(original, key, false)).toBe(original);
      expect(nudgeGraphBand(original, key, true)).toBe(original);
    },
  );

  it("changes only the keyboard axis, leaving unedited gain and Q exact", () => {
    expect(nudgeGraphBand(band(), "ArrowRight", false)).toEqual(
      band({ frequency: 1059 }),
    );
    expect(nudgeGraphBand(band(), "ArrowUp", false)).toEqual(
      band({ gain: 4.4 }),
    );
    expect(nudgeGraphBand(band(), "Home", false)).toEqual(band({ gain: 0 }));
    expect(nudgeGraphBand(band(), " ", false)).toBeNull();
  });
});

describe("active point preview rebasing", () => {
  it("keeps +7.7 dB and frequency edits while Space adds a second slot", () => {
    const base = [
      band({ gain: -3, q: 2 }),
      band({ id: 2, enabled: false, gain: 0, q: 0.75 }),
    ];
    const draft = [band({ gain: 7.7, frequency: 1200, q: 2 }), base[1]];
    const patch = captureBandPreview(base, draft);
    expect([...patch]).toEqual([[1, { frequency: 1200, gain: 7.7 }]]);
    const added = [base[0], band({ id: 2, frequency: 1200, gain: -3, q: 2 })];
    const preview = applyBandPreview(added, patch);
    expect(preview).toEqual([draft[0], added[1]]);
    expect(added[0].gain).toBe(-3);
    expect(added[1].enabled).toBe(true);
    expect(preview[1]).toBe(added[1]);
    expect(applyBandPreview(added, null)).toBe(added);
  });

  it("does not overwrite a newer unedited Q or resurrect removed slots", () => {
    const base = [band({ gain: -3, q: 2 })];
    const patch = captureBandPreview(base, [band({ gain: 7.7, q: 2 })]);
    expect(applyBandPreview([band({ gain: -3, q: 7 })], patch)).toEqual([
      band({ gain: 7.7, q: 7 }),
    ]);
    expect(applyBandPreview([], patch)).toEqual([]);
    expect(applyBandPreview([band({ enabled: false })], patch)[0].enabled).toBe(
      false,
    );
  });

  it("does not capture unchanged slots or mutate incoming profiles", () => {
    const original = [band()];
    const patch = captureBandPreview(
      original,
      original.map((item) => ({ ...item })),
    );
    expect(patch.size).toBe(0);
    expect(applyBandPreview(original, patch)).toBe(original);
  });
});
