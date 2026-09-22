import { describe, expect, it } from "vitest";
import {
  FACTORY_PRESETS,
  FLAT_PROFILE,
  LIMITS,
  SAMPLE_RATE,
  bandResponseDb,
  clamp,
  cloneProfile,
  getResponsePoints,
  normalizeBand,
  parseProfile,
  profileResponseDb,
  profilesEqual,
  recommendedPreamp,
  serializeProfile,
} from "./eq";
import type { Band, Profile } from "./eq";

function band(overrides: Partial<Band> = {}): Band {
  return {
    id: 1,
    type: "peak",
    frequency: 1000,
    gain: 3,
    q: 0.75,
    enabled: true,
    ...overrides,
  };
}

function profile(overrides: Partial<Band>[] = [], preamp = 0): Profile {
  const result = cloneProfile(FLAT_PROFILE);
  result.preamp = preamp;
  overrides.forEach((values, index) =>
    Object.assign(result.bands[index]!, values),
  );
  return result;
}

function envelope(): {
  version: unknown;
  profile: Record<string, unknown> & { bands: Record<string, unknown>[] };
} {
  return JSON.parse(serializeProfile(FLAT_PROFILE));
}

function densePeak(value: Profile, count = 20001): number {
  return getResponsePoints(value, count, false).reduce(
    (peak, point) => Math.max(peak, point.gain),
    0,
  );
}

// Independent oracle: evaluate the six RBJ coefficients with complex arithmetic.
function referenceMagnitude(value: Band, frequency: number): number {
  const amplitude = 10 ** (value.gain / 40);
  const center = (2 * Math.PI * value.frequency) / SAMPLE_RATE;
  const alpha = Math.sin(center) / (2 * value.q);
  const b = [
    1 + alpha * amplitude,
    -2 * Math.cos(center),
    1 - alpha * amplitude,
  ];
  const a = [
    1 + alpha / amplitude,
    -2 * Math.cos(center),
    1 - alpha / amplitude,
  ];
  const omega = (2 * Math.PI * frequency) / SAMPLE_RATE;
  const power = (coefficients: number[]) => {
    const real =
      coefficients[0]! +
      coefficients[1]! * Math.cos(omega) +
      coefficients[2]! * Math.cos(2 * omega);
    const imaginary =
      -coefficients[1]! * Math.sin(omega) -
      coefficients[2]! * Math.sin(2 * omega);
    return real ** 2 + imaginary ** 2;
  };
  return 10 * Math.log10(power(b) / power(a));
}

describe("defaults and starter presets", () => {
  it("exports the Protocol Micro limits and visualization sample rate", () => {
    expect(SAMPLE_RATE).toBe(96000);
    expect(LIMITS).toEqual({
      frequencyMin: 20,
      frequencyMax: 20000,
      gainMin: -10,
      gainMax: 10,
      qMin: 0.1,
      qMax: 10,
      preampMin: -20,
      preampMax: 0,
    });
  });

  it("provides eight flat baseline bands", () => {
    expect(FLAT_PROFILE).toEqual({
      id: "flat",
      name: "Flat",
      description: "An untouched starting point.",
      preamp: 0,
      bands: [31, 62, 125, 250, 500, 1000, 2000, 4000].map(
        (frequency, index) => ({
          id: index + 1,
          type: "peak",
          frequency,
          gain: 0,
          q: 0.75,
          enabled: true,
        }),
      ),
    });
  });

  it("provides the named presets with warm first", () => {
    expect(FACTORY_PRESETS.map(({ id, name }) => [id, name])).toEqual([
      ["warm", "Warm & balanced"],
      ["flat", "Flat"],
      ["vocal", "Vocal clarity"],
      ["bass", "Bass lift"],
      ["soft", "Soft treble"],
      ["night", "Late night"],
    ]);
    expect(FACTORY_PRESETS[0]!.bands.map(({ frequency }) => frequency)).toEqual(
      [40, 90, 250, 600, 1600, 3500, 7000, 12000],
    );
  });

  it.each(FACTORY_PRESETS)(
    "$id is valid, moderate, and has calculated headroom",
    (value) => {
      expect(parseProfile(serializeProfile(value))).toEqual(value);
      expect(
        value.bands.every(
          ({ gain, enabled }) => Math.abs(gain) <= 3 && enabled,
        ),
      ).toBe(true);
      expect(value.preamp).toBe(recommendedPreamp(value));
      expect(densePeak(value) + value.preamp).toBeLessThanOrEqual(1e-8);
      expect(densePeak(value)).toBeLessThan(4);
      if (value.id !== "flat")
        expect(value.description).toMatch(/starter preset, not a measurement/i);
      if (value.bands.some(({ gain }) => gain > 0))
        expect(value.preamp).toBeLessThan(0);
    },
  );

  it("does not share band objects between presets or with the flat baseline", () => {
    const bands = [FLAT_PROFILE, ...FACTORY_PRESETS].flatMap(
      (value) => value.bands,
    );
    expect(new Set(bands).size).toBe(bands.length);
    expect(FACTORY_PRESETS.find(({ id }) => id === "flat")).toEqual(
      FLAT_PROFILE,
    );
  });
});

describe("editing helpers", () => {
  it.each([
    [-30, -10, 10, -10],
    [30, -10, 10, 10],
    [1.25, -10, 10, 1.25],
    [0, -10, 10, 0],
    [-10, -10, 10, -10],
    [10, -10, 10, 10],
    [Infinity, -10, 10, 10],
    [-Infinity, -10, 10, -10],
    [NaN, -10, 10, -10],
    [30, 5, 5, 5],
  ])("clamp(%s, %s, %s) returns %s", (value, min, max, expected) => {
    expect(clamp(value, min, max)).toBe(expected);
  });

  it("deep-clones the editable profile without changing its ID", () => {
    const copy = cloneProfile(FLAT_PROFILE);
    expect(copy).toEqual(FLAT_PROFILE);
    expect(copy).not.toBe(FLAT_PROFILE);
    expect(copy.bands).not.toBe(FLAT_PROFILE.bands);
    expect(copy.bands[0]).not.toBe(FLAT_PROFILE.bands[0]);
    copy.bands[0]!.gain = 2;
    copy.name = "Edited";
    expect(FLAT_PROFILE.bands[0]!.gain).toBe(0);
    expect(FLAT_PROFILE.name).toBe("Flat");
  });

  it("rounds frequency, gain, and Q without mutating its input", () => {
    const input = Object.freeze(
      band({ frequency: 1234.56, gain: -1.26, q: 1.236, enabled: false }),
    );
    const result = normalizeBand(input);
    expect(result).toEqual(
      band({ frequency: 1235, gain: -1.3, q: 1.24, enabled: false }),
    );
    expect(result).not.toBe(input);
    expect(input.frequency).toBe(1234.56);
    expect(normalizeBand(result)).toEqual(result);
  });

  it("clamps each editable number before rounding", () => {
    expect(normalizeBand(band({ frequency: -1, gain: -20, q: 0 }))).toEqual(
      band({ frequency: 20, gain: -10, q: 0.1 }),
    );
    expect(normalizeBand(band({ frequency: 25000, gain: 20, q: 20 }))).toEqual(
      band({ frequency: 20000, gain: 10, q: 10 }),
    );
  });

  it.each([NaN, Infinity, -Infinity])(
    "uses flat defaults for non-finite inputs (%s)",
    (invalid) => {
      expect(
        normalizeBand(
          band({ id: 3, frequency: invalid, gain: invalid, q: invalid }),
        ),
      ).toEqual(band({ id: 3, frequency: 125, gain: 0, q: 0.75 }));
    },
  );

  it("sanitizes invalid runtime fields without coercing numeric strings", () => {
    const invalid = {
      id: NaN,
      type: "shelf",
      frequency: "120",
      gain: null,
      q: undefined,
      enabled: "false",
    } as unknown as Band;
    expect(normalizeBand(invalid)).toEqual({
      id: 1,
      type: "peak",
      frequency: 31,
      gain: 0,
      q: 0.75,
      enabled: true,
    });
    expect(normalizeBand(band({ id: 20 })).id).toBe(8);
    expect(normalizeBand(band({ id: -1 })).id).toBe(1);
    expect(normalizeBand(band({ id: 2.6 })).id).toBe(3);
  });

  it("does not return negative zero for a rounded gain", () => {
    expect(normalizeBand(band({ gain: -0.01 })).gain).toBe(0);
  });
});

describe("true peak biquad response", () => {
  it("has exactly flat magnitude at zero gain across the audible range", () => {
    for (const point of getResponsePoints(FLAT_PROFILE, 1001)) {
      expect(point.gain).toBe(0);
      expect(bandResponseDb(band({ gain: 0 }), point.frequency)).toBe(0);
    }
  });

  it.each([20, 31, 1000, 19731, 20000])(
    "matches the specified gain at %s Hz for all supported Q extremes",
    (frequency) => {
      for (const q of [0.1, 0.75, 10]) {
        for (const gain of [-10, -3.4, 1.3, 10]) {
          expect(
            bandResponseDb(band({ frequency, gain, q }), frequency),
          ).toBeCloseTo(gain, 10);
        }
      }
    },
  );

  it.each([
    { frequency: 31, gain: 10, q: 10 },
    { frequency: 1000, gain: -6, q: 0.75 },
    { frequency: 12000, gain: 3, q: 0.1 },
    { frequency: 20000, gain: 8, q: 10 },
  ])(
    "matches a coefficient-based oracle away from the center: %j",
    (settings) => {
      const value = band(settings);
      for (const frequency of [
        20, 40, 400, 800, 1700, 2000, 3500, 12000, 20000,
      ]) {
        expect(bandResponseDb(value, frequency)).toBeCloseTo(
          referenceMagnitude(value, frequency),
          7,
        );
      }
    },
  );

  it("uses Q to control bandwidth", () => {
    expect(bandResponseDb(band({ q: 0.1 }), 2000)).toBeGreaterThan(
      bandResponseDb(band({ q: 10 }), 2000),
    );
  });

  it("makes equal boosts and cuts reciprocal", () => {
    for (const frequency of [20, 100, 800, 1000, 1500, 10000, 20000]) {
      const sum =
        bandResponseDb(band({ gain: 4 }), frequency) +
        bandResponseDb(band({ gain: -4 }), frequency);
      expect(sum).toBeCloseTo(0, 12);
    }
  });

  it("returns zero for a bypassed band and at DC and Nyquist", () => {
    expect(bandResponseDb(band({ gain: 10, enabled: false }), 1000)).toBe(0);
    expect(bandResponseDb(band(), 0)).toBe(0);
    expect(bandResponseDb(band(), SAMPLE_RATE / 2)).toBe(0);
  });

  it.each([NaN, Infinity, -1, SAMPLE_RATE / 2 + 1])(
    "rejects invalid response frequency %s",
    (frequency) => {
      expect(() => bandResponseDb(band(), frequency)).toThrow(/frequency/i);
      expect(() => profileResponseDb(FLAT_PROFILE, frequency)).toThrow(
        /frequency/i,
      );
    },
  );
});

describe("combined response and plot points", () => {
  const value = profile(
    [
      { frequency: 900, gain: 2.4, q: 0.8 },
      { frequency: 1400, gain: -1.2, q: 1.1 },
      { frequency: 1000, gain: 10, enabled: false },
    ],
    -3,
  );

  it.each([20, 100, 900, 1000, 5000, 20000])(
    "sums enabled filters in dB and adds preamp at %s Hz",
    (frequency) => {
      const expected = value.bands.reduce(
        (sum, current) => sum + bandResponseDb(current, frequency),
        0,
      );
      expect(profileResponseDb(value, frequency, false)).toBeCloseTo(
        expected,
        12,
      );
      expect(profileResponseDb(value, frequency)).toBeCloseTo(expected - 3, 12);
    },
  );

  it("keeps preamp active when all filters are bypassed", () => {
    const bypassed = profile(
      Array.from({ length: 8 }, () => ({ enabled: false, gain: 10 })),
      -2,
    );
    expect(profileResponseDb(bypassed, 1000)).toBe(-2);
    expect(profileResponseDb(bypassed, 1000, false)).toBe(0);
  });

  it("returns 240 ordered logarithmic points including both endpoints by default", () => {
    const points = getResponsePoints(value);
    expect(points).toHaveLength(240);
    expect(points[0]!.frequency).toBe(20);
    expect(points[239]!.frequency).toBe(20000);
    const ratio = 1000 ** (1 / 239);
    points.forEach((point, index) => {
      expect(point.gain).toBeCloseTo(
        profileResponseDb(value, point.frequency),
        12,
      );
      if (index > 0) {
        expect(point.frequency).toBeGreaterThan(points[index - 1]!.frequency);
        expect(point.frequency / points[index - 1]!.frequency).toBeCloseTo(
          ratio,
          12,
        );
      }
    });
  });

  it("can omit preamp from plot points", () => {
    const withPreamp = getResponsePoints(value, 17);
    const withoutPreamp = getResponsePoints(value, 17, false);
    withoutPreamp.forEach((point, index) => {
      expect(point.frequency).toBe(withPreamp[index]!.frequency);
      expect(point.gain - 3).toBeCloseTo(withPreamp[index]!.gain, 12);
    });
  });

  it("defines zero-, one-, and two-point requests", () => {
    expect(getResponsePoints(FLAT_PROFILE, 0)).toEqual([]);
    expect(getResponsePoints(FLAT_PROFILE, 1)).toEqual([
      { frequency: 20, gain: 0 },
    ]);
    expect(getResponsePoints(FLAT_PROFILE, 2)).toEqual([
      { frequency: 20, gain: 0 },
      { frequency: 20000, gain: 0 },
    ]);
  });

  it.each([-1, 1.5, NaN, Infinity])(
    "rejects invalid point count %s",
    (count) => {
      expect(() => getResponsePoints(value, count)).toThrow(/count/i);
    },
  );

  it("does not mutate the profile while evaluating it", () => {
    const original = cloneProfile(value);
    const frozen = cloneProfile(value);
    frozen.bands.forEach(Object.freeze);
    Object.freeze(frozen.bands);
    Object.freeze(frozen);
    getResponsePoints(frozen);
    profileResponseDb(frozen, 1000);
    recommendedPreamp(frozen);
    expect(frozen).toEqual(original);
  });
});

describe("recommended preamp", () => {
  it("returns zero, not negative zero, for flat, cut-only, and bypassed profiles", () => {
    expect(recommendedPreamp(FLAT_PROFILE)).toBe(0);
    expect(recommendedPreamp(profile([{ gain: -10 }], -20))).toBe(0);
    expect(
      recommendedPreamp(
        profile(
          Array.from({ length: 8 }, () => ({ gain: 10, enabled: false })),
          -20,
        ),
      ),
    ).toBe(0);
  });

  it("ignores existing preamp rather than accumulating attenuation", () => {
    const value = profile([{ frequency: 1000, gain: 2.3 }]);
    expect(recommendedPreamp(value)).toBe(-2.3);
    value.preamp = -18;
    expect(recommendedPreamp(value)).toBe(-2.3);
  });

  it("rounds headroom downward to a tenth and catches peaks between plot points", () => {
    const value = profile([{ frequency: 1000, gain: 2.01, q: 10 }]);
    expect(densePeak(value, 240)).toBeLessThan(2);
    expect(recommendedPreamp(value)).toBe(-2.1);
    expect(
      profileResponseDb({ ...value, preamp: recommendedPreamp(value) }, 1000),
    ).toBeLessThan(0);
  });

  it("uses the combined peak rather than the largest individual gain", () => {
    const value = profile([
      { frequency: 1000, gain: 2.4, q: 1 },
      { frequency: 1000, gain: 2.4, q: 1 },
    ]);
    expect(recommendedPreamp(value)).toBe(-4.8);
  });

  it("does not add peak gains from widely separated filters", () => {
    const value = profile([
      { frequency: 31, gain: 10, q: 10 },
      { frequency: 16000, gain: 10, q: 10 },
    ]);
    expect(recommendedPreamp(value)).toBeLessThanOrEqual(-10);
    expect(recommendedPreamp(value)).toBeGreaterThan(-10.5);
  });

  it("includes cuts when finding the net peak", () => {
    const value = profile([
      { frequency: 1000, gain: 4, q: 1 },
      { frequency: 1000, gain: -4, q: 1 },
    ]);
    expect(recommendedPreamp(value)).toBe(0);
  });

  it("finds an overlapping peak between band centers", () => {
    const value = profile([
      { frequency: 1000, gain: 4, q: 3 },
      { frequency: 1180, gain: 4, q: 3 },
    ]);
    const peak = densePeak(value, 50001);
    const centerPeak = Math.max(
      profileResponseDb(value, 1000, false),
      profileResponseDb(value, 1180, false),
    );
    expect(peak).toBeGreaterThan(centerPeak + 0.1);
    const preamp = recommendedPreamp(value);
    expect(peak + preamp).toBeLessThanOrEqual(1e-8);
    expect(peak + preamp).toBeGreaterThan(-0.1001);
  });

  it.each([20, 20000])(
    "includes the audible endpoint at %s Hz",
    (frequency) => {
      expect(recommendedPreamp(profile([{ frequency, gain: 3, q: 10 }]))).toBe(
        -3,
      );
    },
  );

  it("reports headroom below the editable preamp limit when a curve requires it", () => {
    const value = profile(
      Array.from({ length: 8 }, () => ({ frequency: 1000, gain: 10, q: 1 })),
    );
    expect(recommendedPreamp(value)).toBe(-80);
  });

  it("covers dense sweeps of deterministic mixed curves across the allowed ranges", () => {
    let seed = 42;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let index = 0; index < 16; index += 1) {
      const value = profile(
        Array.from({ length: 8 }, () => ({
          frequency: 20 * 1000 ** random(),
          gain: -10 + 20 * random(),
          q: 0.1 + 9.9 * random(),
          enabled: random() > 0.2,
        })),
      );
      const preamp = recommendedPreamp(value);
      expect(preamp).toBeLessThanOrEqual(0);
      expect(preamp * 10).toBeCloseTo(Math.round(preamp * 10), 10);
      expect(densePeak(value) + preamp).toBeLessThanOrEqual(1e-8);
    }
  });
});

describe("profile equality", () => {
  it("ignores profile ID and band array order", () => {
    const copy = cloneProfile(FLAT_PROFILE);
    copy.id = "custom-copy";
    copy.bands.reverse();
    expect(profilesEqual(FLAT_PROFILE, copy)).toBe(true);
    expect(profilesEqual(copy, FLAT_PROFILE)).toBe(true);
  });

  it.each([{ name: "Changed" }, { description: "Changed" }, { preamp: -0.1 }])(
    "compares editable profile metadata: %j",
    (change) => {
      expect(
        profilesEqual(FLAT_PROFILE, {
          ...cloneProfile(FLAT_PROFILE),
          ...change,
        }),
      ).toBe(false);
    },
  );

  it.each([
    { frequency: 32 },
    { gain: 0.1 },
    { q: 0.76 },
    { enabled: false },
    { type: "shelf" as Band["type"] },
    { id: 9 },
  ])("compares each editable band field and slot: %j", (change) => {
    expect(profilesEqual(FLAT_PROFILE, profile([change]))).toBe(false);
  });

  it("compares band count and preserves differences on bypassed bands", () => {
    const shorter = cloneProfile(FLAT_PROFILE);
    shorter.bands.pop();
    expect(profilesEqual(FLAT_PROFILE, shorter)).toBe(false);
    expect(
      profilesEqual(
        profile([{ enabled: false }]),
        profile([{ enabled: false, gain: 1 }]),
      ),
    ).toBe(false);
  });
});

describe("versioned profile JSON", () => {
  it("round-trips every editable field and retains IDs and numeric precision", () => {
    const value = profile(
      [{ frequency: 1000.123, gain: 1.234, q: 0.7567, enabled: false }],
      -1.234,
    );
    value.id = "custom-123";
    value.name = "夜間 🎧";
    value.description = "First line.\nSecond line.";
    const text = serializeProfile(value);
    expect(JSON.parse(text)).toEqual({ version: 1, profile: value });
    const parsed = parseProfile(text);
    expect(parsed).toEqual(value);
    expect(profilesEqual(parsed, value)).toBe(true);
    parsed.bands[0]!.gain = -5;
    expect(value.bands[0]!.gain).toBe(1.234);
  });

  it.each([-20, 0])(
    "accepts all numeric boundaries with preamp %s",
    (preamp) => {
      const value = profile(
        [
          { frequency: 20, gain: -10, q: 0.1 },
          { frequency: 20000, gain: 10, q: 10 },
        ],
        preamp,
      );
      expect(parseProfile(serializeProfile(value))).toEqual(value);
    },
  );

  it("accepts all eight IDs in any order", () => {
    const value = cloneProfile(FLAT_PROFILE);
    value.bands.reverse();
    expect(parseProfile(serializeProfile(value))).toEqual(value);
  });

  it.each(["", "{", "not JSON", '{"version":1,}', "// comment\n{}"])(
    "reports malformed JSON: %j",
    (text) => {
      expect(() => parseProfile(text)).toThrow(/invalid JSON/i);
    },
  );

  it.each(["null", "[]", "42", '"profile"', "true"])(
    "rejects a non-object envelope: %s",
    (text) => {
      expect(() => parseProfile(text)).toThrow(/profile file/i);
    },
  );

  it.each([undefined, null, 0, 2, "1", true])(
    "rejects an unsupported or missing version: %s",
    (version) => {
      const value = envelope();
      value.version = version;
      expect(() => parseProfile(JSON.stringify(value))).toThrow(/version/i);
    },
  );

  it.each([undefined, null, [], "profile", 1])(
    "rejects a missing or invalid profile: %j",
    (value) => {
      expect(() =>
        parseProfile(JSON.stringify({ version: 1, profile: value })),
      ).toThrow(/profile must be an object/i);
    },
  );

  it.each(["id", "name", "description", "preamp", "bands"])(
    "rejects a missing profile field: %s",
    (key) => {
      const value = envelope();
      delete value.profile[key];
      expect(() => parseProfile(JSON.stringify(value))).toThrow(Error);
    },
  );

  it.each(["frequency", "gain", "q"])(
    "rejects missing and non-numeric %s without coercion",
    (key) => {
      for (const invalid of [
        undefined,
        null,
        "1",
        "NaN",
        "Infinity",
        true,
        {},
        [],
      ]) {
        const value = envelope();
        value.profile.bands[0]![key] = invalid;
        expect(() => parseProfile(JSON.stringify(value))).toThrow(
          /finite number/i,
        );
      }
    },
  );

  it.each([
    ["frequency", 19.999],
    ["frequency", 20000.001],
    ["gain", -10.001],
    ["gain", 10.001],
    ["q", 0.099],
    ["q", 10.001],
  ] as const)(
    "rejects out-of-range band %s=%s rather than clamping",
    (key, invalid) => {
      const value = envelope();
      value.profile.bands[0]![key] = invalid;
      expect(() => parseProfile(JSON.stringify(value))).toThrow(
        /finite number/i,
      );
    },
  );

  it.each([-20.001, 0.001, null, "0", true])(
    "rejects invalid preamp %j",
    (invalid) => {
      const value = envelope();
      value.profile.preamp = invalid;
      expect(() => parseProfile(JSON.stringify(value))).toThrow(/preamp/i);
    },
  );

  it.each(["frequency", "gain", "q", "preamp"])(
    "rejects JSON numbers that overflow to infinity: %s",
    (key) => {
      for (const literal of ["1e309", "-1e309"]) {
        const text = serializeProfile(FLAT_PROFILE).replace(
          new RegExp(`"${key}": [\\d.-]+`),
          `"${key}": ${literal}`,
        );
        expect(() => parseProfile(text)).toThrow(/finite number/i);
      }
    },
  );

  it.each([0, 7, 9])("rejects %s bands", (count) => {
    const value = envelope();
    value.profile.bands = Array.from({ length: count }, (_, index) => ({
      ...value.profile.bands[index % 8]!,
    }));
    expect(() => parseProfile(JSON.stringify(value))).toThrow(
      /exactly 8 bands/i,
    );
  });

  it.each([null, {}, "bands"])(
    "rejects a non-array bands field: %j",
    (bands) => {
      const value = envelope();
      expect(() =>
        parseProfile(
          JSON.stringify({ ...value, profile: { ...value.profile, bands } }),
        ),
      ).toThrow(/exactly 8 bands/i);
    },
  );

  it.each([null, [], 1, "band"])("rejects a non-object band: %j", (invalid) => {
    const value = envelope();
    const bands: unknown[] = [...value.profile.bands];
    bands[0] = invalid;
    expect(() =>
      parseProfile(
        JSON.stringify({ ...value, profile: { ...value.profile, bands } }),
      ),
    ).toThrow(/band 1 must be an object/i);
  });

  it.each([undefined, null, 0, 9, 1.1, "1", true])(
    "rejects missing or invalid band ID: %j",
    (id) => {
      const value = envelope();
      value.profile.bands[0]!.id = id;
      expect(() => parseProfile(JSON.stringify(value))).toThrow(
        /ID must be an integer from 1 to 8/i,
      );
    },
  );

  it("rejects duplicate band IDs even when the count is correct", () => {
    const value = envelope();
    value.profile.bands[7]!.id = 1;
    expect(() => parseProfile(JSON.stringify(value))).toThrow(
      /band IDs must be unique/i,
    );
  });

  it.each([undefined, null, "lowshelf", "highshelf", "PEAK", 1])(
    "rejects unsupported or missing filter type: %j",
    (type) => {
      const value = envelope();
      value.profile.bands[0]!.type = type;
      value.profile.bands[0]!.enabled = false;
      expect(() => parseProfile(JSON.stringify(value))).toThrow(
        /unsupported filter type/i,
      );
    },
  );

  it.each([undefined, null, 0, 1, "true", "false", [], {}])(
    "rejects missing or invalid enabled: %j",
    (enabled) => {
      const value = envelope();
      value.profile.bands[0]!.enabled = enabled;
      expect(() => parseProfile(JSON.stringify(value))).toThrow(
        /enabled must be true or false/i,
      );
    },
  );

  it.each([
    undefined,
    null,
    1,
    "",
    "   ",
    "\t\n",
    "x".repeat(81),
    "Name\nnext",
    "Name\u0000",
    "Name\u007f",
  ])("rejects invalid profile name: %j", (name) => {
    const value = envelope();
    value.profile.name = name;
    expect(() => parseProfile(JSON.stringify(value))).toThrow(/profile name/i);
  });

  it.each([null, 1, "", "  ", "x".repeat(129), "id\nnext"])(
    "rejects invalid profile ID: %j",
    (id) => {
      const value = envelope();
      value.profile.id = id;
      expect(() => parseProfile(JSON.stringify(value))).toThrow(/profile ID/i);
    },
  );

  it.each([null, 1, "x".repeat(2001), "text\u0000"])(
    "rejects invalid description: %j",
    (description) => {
      const value = envelope();
      value.profile.description = description;
      expect(() => parseProfile(JSON.stringify(value))).toThrow(/description/i);
    },
  );

  it("accepts empty descriptions and valid name length boundaries", () => {
    for (const name of ["x", "x".repeat(80)]) {
      const value = { ...cloneProfile(FLAT_PROFILE), name, description: "" };
      expect(parseProfile(serializeProfile(value))).toEqual(value);
    }
  });

  it("rejects input above 1 MB before parsing and accepts the exact byte limit", () => {
    const text = serializeProfile(FLAT_PROFILE);
    expect(parseProfile(text.padEnd(1024 * 1024, " "))).toEqual(FLAT_PROFILE);
    expect(() => parseProfile(text.padEnd(1024 * 1024 + 1, " "))).toThrow(
      /1 MB/i,
    );
    expect(() => parseProfile("!".repeat(1024 * 1024 + 1))).toThrow(/1 MB/i);
  });

  it("measures the import limit in UTF-8 bytes, not UTF-16 string length", () => {
    const text = JSON.stringify({ ...envelope(), padding: "é".repeat(524288) });
    expect(text.length).toBeLessThan(1024 * 1024);
    expect(() => parseProfile(text)).toThrow(/1 MB/i);
  });

  it("treats imported strings as data and discards unknown properties", () => {
    const value = envelope();
    value.profile.description =
      '<script>throw new Error("Do not execute")</script>';
    value.profile.bands[0]!.command = "sendReport";
    const text = JSON.stringify(value).replace(
      '"profile":{',
      '"profile":{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},',
    );
    const parsed = parseProfile(text);
    expect(parsed.description).toBe(value.profile.description);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Object.keys(parsed)).toEqual([
      "id",
      "name",
      "description",
      "preamp",
      "bands",
    ]);
    expect(Object.keys(parsed.bands[0]!)).toEqual([
      "id",
      "type",
      "frequency",
      "gain",
      "q",
      "enabled",
    ]);
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("rejects invalid exports instead of silently serializing non-finite values as null", () => {
    expect(() => serializeProfile(profile([{ gain: NaN }]))).toThrow(
      /finite number/i,
    );
    expect(() => serializeProfile(profile([], Infinity))).toThrow(/preamp/i);
  });

  it("reports a friendly error for a non-string runtime import", () => {
    expect(() => parseProfile(null as unknown as string)).toThrow(/JSON text/i);
  });
});
