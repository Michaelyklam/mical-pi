export type Band = {
  id: number;
  type: "peak";
  frequency: number;
  gain: number;
  q: number;
  enabled: boolean;
};

export type Profile = {
  id: string;
  name: string;
  description: string;
  preamp: number;
  bands: Band[];
};

export const LIMITS = Object.freeze({
  frequencyMin: 20,
  frequencyMax: 20000,
  gainMin: -10,
  gainMax: 10,
  qMin: 0.1,
  qMax: 10,
  preampMin: -20,
  preampMax: 0,
});

export const SAMPLE_RATE = 96000;

const BASELINE_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000];
const BAND_COUNT = 8;
const DEFAULT_Q = 0.75;
const MAX_IMPORT_BYTES = 1024 * 1024;

/** Clamp infinities to the bounds and use the lower bound for NaN. */
export function clamp(value: number, min: number, max: number): number {
  return Number.isNaN(value) ? min : Math.min(max, Math.max(min, value));
}

export function cloneProfile(profile: Profile): Profile {
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description,
    preamp: profile.preamp,
    bands: profile.bands.map((band) => ({ ...band })),
  };
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function round(value: number, places: number): number {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale || 0;
}

/** Editing helper. Invalid numbers use flat defaults; imports use strict validation. */
export function normalizeBand(band: Band): Band {
  const id = Math.round(clamp(finiteOr(band.id, 1), 1, BAND_COUNT));
  return {
    id,
    type: "peak",
    frequency: round(
      clamp(
        finiteOr(band.frequency, BASELINE_FREQUENCIES[id - 1]!),
        LIMITS.frequencyMin,
        LIMITS.frequencyMax,
      ),
      0,
    ),
    gain: round(
      clamp(finiteOr(band.gain, 0), LIMITS.gainMin, LIMITS.gainMax),
      1,
    ),
    q: round(clamp(finiteOr(band.q, DEFAULT_Q), LIMITS.qMin, LIMITS.qMax), 2),
    enabled: typeof band.enabled === "boolean" ? band.enabled : true,
  };
}

export const FLAT_PROFILE: Profile = {
  id: "flat",
  name: "Flat",
  description: "An untouched starting point.",
  preamp: 0,
  bands: BASELINE_FREQUENCIES.map((frequency, index) => ({
    id: index + 1,
    type: "peak",
    frequency,
    gain: 0,
    q: DEFAULT_Q,
    enabled: true,
  })),
};

type PeakFilter = { omega: number; alpha: number; amplitude: number };

function peakFilter(band: Band): PeakFilter {
  const omega = (2 * Math.PI * band.frequency) / SAMPLE_RATE;
  return {
    omega,
    alpha: Math.sin(omega) / (2 * band.q),
    amplitude: 10 ** (band.gain / 40),
  };
}

function activeFilters(profile: Profile): PeakFilter[] {
  return profile.bands
    .filter((band) => band.enabled && band.gain !== 0)
    .map(peakFilter);
}

function responseOmega(frequency: number): number {
  if (
    !Number.isFinite(frequency) ||
    frequency < 0 ||
    frequency > SAMPLE_RATE / 2
  ) {
    throw new RangeError("Response frequency must be between 0 and 48000 Hz.");
  }
  return (2 * Math.PI * frequency) / SAMPLE_RATE;
}

function filterResponseDb(filter: PeakFilter, omega: number): number {
  // RBJ peaking biquad: b = [1 + alpha*A, -2*cos(w0), 1 - alpha*A],
  // a = [1 + alpha/A, -2*cos(w0), 1 - alpha/A]. Multiplying by z gives
  // |H|² = (delta² + (alpha*A*sin(w))²) / (delta² + (alpha/A*sin(w))²).
  // The sine identity avoids subtracting nearly equal cosines at low frequencies.
  const delta =
    -2 *
    Math.sin((omega + filter.omega) / 2) *
    Math.sin((omega - filter.omega) / 2);
  const width = filter.alpha * Math.sin(omega);
  const numerator = delta ** 2 + (width * filter.amplitude) ** 2;
  const denominator = delta ** 2 + (width / filter.amplitude) ** 2;
  return 10 * Math.log10(numerator / denominator);
}

function sumResponseDb(filters: PeakFilter[], omega: number): number {
  return filters.reduce(
    (sum, filter) => sum + filterResponseDb(filter, omega),
    0,
  );
}

/** True peaking-biquad magnitude at 96 kHz. Frequency may span DC to Nyquist. */
export function bandResponseDb(band: Band, frequency: number): number {
  const omega = responseOmega(frequency);
  return !band.enabled || band.gain === 0
    ? 0
    : filterResponseDb(peakFilter(band), omega);
}

export function profileResponseDb(
  profile: Profile,
  frequency: number,
  includePreamp = true,
): number {
  return (
    sumResponseDb(activeFilters(profile), responseOmega(frequency)) +
    (includePreamp ? profile.preamp : 0)
  );
}

/** Zero points returns []; one point uses 20 Hz. Other counts include both endpoints. */
export function getResponsePoints(
  profile: Profile,
  count = 240,
  includePreamp = true,
): { frequency: number; gain: number }[] {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError("Point count must be a non-negative integer.");
  }
  const filters = activeFilters(profile);
  const preamp = includePreamp ? profile.preamp : 0;
  const ratio = LIMITS.frequencyMax / LIMITS.frequencyMin;
  return Array.from({ length: count }, (_, index) => {
    const frequency =
      count > 1 && index === count - 1
        ? LIMITS.frequencyMax
        : LIMITS.frequencyMin * ratio ** (index / Math.max(1, count - 1));
    return {
      frequency,
      gain: sumResponseDb(filters, responseOmega(frequency)) + preamp,
    };
  });
}

function refinePeak(
  response: (logFrequency: number) => number,
  left: number,
  right: number,
): number {
  const ratio = (Math.sqrt(5) - 1) / 2;
  let x1 = right - ratio * (right - left);
  let x2 = left + ratio * (right - left);
  let y1 = response(x1);
  let y2 = response(x2);
  for (let iteration = 0; iteration < 40; iteration += 1) {
    if (y1 < y2) {
      left = x1;
      x1 = x2;
      y1 = y2;
      x2 = left + ratio * (right - left);
      y2 = response(x2);
    } else {
      right = x2;
      x2 = x1;
      y2 = y1;
      x1 = right - ratio * (right - left);
      y1 = response(x1);
    }
  }
  return Math.max(y1, y2);
}

/**
 * Headroom for the summed enabled filters over 20..20000 Hz, ignoring existing preamp.
 * Refine local maxima on a dense log grid, including exact band centers. The grid
 * is denser than the plot because Q=10 peaks can fall between its 240 points.
 * Do not clamp to preampMin: an extreme curve can need more than 20 dB of headroom.
 */
export function recommendedPreamp(profile: Profile): number {
  if (!profile.bands.some((band) => band.enabled && band.gain > 0)) return 0;

  const filters = activeFilters(profile);
  const response = (logFrequency: number) =>
    sumResponseDb(
      filters,
      responseOmega(Math.min(LIMITS.frequencyMax, Math.exp(logFrequency))),
    );
  const start = Math.log(LIMITS.frequencyMin);
  const span = Math.log(LIMITS.frequencyMax) - start;
  const positions = Array.from(
    { length: 2049 },
    (_, index) => start + (span * index) / 2048,
  );
  for (const band of profile.bands) {
    if (band.enabled && band.gain !== 0)
      positions.push(Math.log(band.frequency));
  }
  const grid = [...new Set(positions)].sort((a, b) => a - b);
  const gains = grid.map(response);
  let peak = Math.max(0, ...gains);
  for (let index = 1; index < grid.length - 1; index += 1) {
    if (
      gains[index]! > gains[index - 1]! &&
      gains[index]! >= gains[index + 1]!
    ) {
      peak = Math.max(
        peak,
        refinePeak(response, grid[index - 1]!, grid[index + 1]!),
      );
    }
  }
  // Ignore sub-nanodecibel round-off at exact tenth-dB peaks; avoid negative zero.
  const tenths = Math.ceil(peak * 10 - 1e-8);
  return tenths > 0 ? -tenths / 10 : 0;
}

/** Ignore profile identity and array order; band IDs identify editable slots. */
export function profilesEqual(a: Profile, b: Profile): boolean {
  if (
    a.name !== b.name ||
    a.description !== b.description ||
    a.preamp !== b.preamp ||
    a.bands.length !== b.bands.length
  )
    return false;
  return a.bands.every((band) => {
    const other = b.bands.find((candidate) => candidate.id === band.id);
    return (
      other !== undefined &&
      band.type === other.type &&
      band.frequency === other.frequency &&
      band.gain === other.gain &&
      band.q === other.q &&
      band.enabled === other.enabled
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(
  value: unknown,
  label: string,
  maxLength: number,
  allowEmpty = false,
): string {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  if (!allowEmpty && value.trim().length === 0)
    throw new Error(`${label} must not be blank.`);
  if (value.length > maxLength)
    throw new Error(`${label} must be ${maxLength} characters or fewer.`);
  // Descriptions may contain tabs and line breaks. Names and IDs must stay on one line.
  const controls = allowEmpty
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/
    : /[\u0000-\u001f\u007f-\u009f]/;
  if (controls.test(value))
    throw new Error(`${label} must not contain control characters.`);
  return value;
}

function readNumber(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(`${label} must be a finite number from ${min} to ${max}.`);
  }
  return value;
}

function readProfile(value: unknown): Profile {
  if (!isRecord(value)) throw new Error("Profile must be an object.");
  const id = readText(value.id, "Profile ID", 128);
  const name = readText(value.name, "Profile name", 80);
  const description = readText(
    value.description,
    "Profile description",
    2000,
    true,
  );
  const preamp = readNumber(
    value.preamp,
    "Preamp",
    LIMITS.preampMin,
    LIMITS.preampMax,
  );
  if (!Array.isArray(value.bands) || value.bands.length !== BAND_COUNT) {
    throw new Error("Profile must contain exactly 8 bands.");
  }
  const ids = new Set<number>();
  const bands = value.bands.map((value: unknown, index): Band => {
    const label = `Band ${index + 1}`;
    if (!isRecord(value)) throw new Error(`${label} must be an object.`);
    const id = value.id;
    if (
      typeof id !== "number" ||
      !Number.isInteger(id) ||
      id < 1 ||
      id > BAND_COUNT
    ) {
      throw new Error(`${label} ID must be an integer from 1 to 8.`);
    }
    if (ids.has(id))
      throw new Error(
        `Band IDs must be unique. Band ${id} appears more than once.`,
      );
    ids.add(id);
    if (value.type !== "peak")
      throw new Error(
        `${label} uses an unsupported filter type. Only peak is supported.`,
      );
    if (typeof value.enabled !== "boolean")
      throw new Error(`${label} enabled must be true or false.`);
    return {
      id,
      type: "peak",
      frequency: readNumber(
        value.frequency,
        `${label} frequency`,
        LIMITS.frequencyMin,
        LIMITS.frequencyMax,
      ),
      gain: readNumber(
        value.gain,
        `${label} gain`,
        LIMITS.gainMin,
        LIMITS.gainMax,
      ),
      q: readNumber(value.q, `${label} Q`, LIMITS.qMin, LIMITS.qMax),
      enabled: value.enabled,
    };
  });
  // Copy only schema fields. Extra import properties remain inert and are discarded.
  return { id, name, description, preamp, bands };
}

/** Validate before exporting so JSON cannot silently turn NaN or Infinity into null. */
export function serializeProfile(profile: Profile): string {
  return JSON.stringify({ version: 1, profile: readProfile(profile) }, null, 2);
}

/** Strict data import: no clamping, rounding, merging, or device operations. */
export function parseProfile(text: string): Profile {
  if (typeof text !== "string")
    throw new Error("Profile import must be JSON text.");
  if (
    text.length > MAX_IMPORT_BYTES ||
    new TextEncoder().encode(text).byteLength > MAX_IMPORT_BYTES
  ) {
    throw new Error("Profile file must be 1 MB or smaller.");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON. Choose a version 1 EQ profile.");
  }
  if (!isRecord(value))
    throw new Error("Invalid profile file. Expected version and profile.");
  if (value.version !== 1)
    throw new Error("Unsupported profile version. Expected version 1.");
  return readProfile(value.profile);
}

function starterPreset(
  id: string,
  name: string,
  description: string,
  settings: [frequency: number, gain: number, q: number][],
): Profile {
  const profile: Profile = {
    id,
    name,
    description,
    preamp: 0,
    bands: settings.map(([frequency, gain, q], index) => ({
      id: index + 1,
      type: "peak",
      frequency,
      gain,
      q,
      enabled: true,
    })),
  };
  profile.preamp = recommendedPreamp(profile);
  return profile;
}

// Editable starting points, not measurements or device correction targets.
// Each preset owns its bands, including the flat copy. Clone before editing.
export const FACTORY_PRESETS: Profile[] = [
  starterPreset(
    "warm",
    "Warm & balanced",
    "Gentle bass warmth and relaxed highs. Starter preset, not a measurement.",
    [
      [40, 1.6, 0.7],
      [90, 1.2, 0.85],
      [250, -0.8, 1],
      [600, -0.4, 0.9],
      [1600, 0.3, 0.85],
      [3500, -0.5, 1.1],
      [7000, -1.2, 0.9],
      [12000, -0.6, 0.7],
    ],
  ),
  cloneProfile(FLAT_PROFILE),
  starterPreset(
    "vocal",
    "Vocal clarity",
    "Less low-mid weight and a small vocal lift. Starter preset, not a measurement.",
    [
      [40, -0.8, 0.7],
      [90, -0.5, 0.8],
      [250, -1.3, 1],
      [600, -0.4, 1],
      [1600, 1.3, 0.9],
      [3500, 1, 1],
      [7000, -0.6, 1.2],
      [12000, -0.5, 0.7],
    ],
  ),
  starterPreset(
    "bass",
    "Bass lift",
    "A low-bass lift with a small low-mid cut. Starter preset, not a measurement.",
    [
      [40, 2.3, 0.7],
      [90, 1.8, 0.8],
      [250, -0.8, 1.1],
      [600, -0.4, 1],
      [1600, 0, 0.9],
      [3500, -0.3, 1],
      [7000, -0.5, 1],
      [12000, -0.3, 0.7],
    ],
  ),
  starterPreset(
    "soft",
    "Soft treble",
    "Mild upper-mid and treble cuts. Starter preset, not a measurement.",
    [
      [40, 0, 0.7],
      [90, 0, 0.8],
      [250, 0, 1],
      [600, 0, 1],
      [1600, -0.3, 0.9],
      [3500, -1.2, 1],
      [7000, -2, 0.9],
      [12000, -1.4, 0.7],
    ],
  ),
  starterPreset(
    "night",
    "Late night",
    "Small bass and vocal lifts for quiet listening. Starter preset, not a measurement.",
    [
      [40, 1.4, 0.7],
      [90, 0.8, 0.9],
      [250, -0.6, 1],
      [600, 0, 1],
      [1600, 0.7, 0.85],
      [3500, 0.5, 1.1],
      [7000, -1.1, 0.9],
      [12000, -0.8, 0.7],
    ],
  ),
];
