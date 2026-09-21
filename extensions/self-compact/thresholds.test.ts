/**
 * Threshold resolution tests for the local (fixed-baseline) defaults.
 *
 * These cover the integration requirements:
 *   - shipped defaults are fixed token counts (~10% / ~20% / ~30% of a 1M baseline),
 *   - the 272,000-token window used by `openai-codex/gpt-6-astra` caps forced at 244,800,
 *   - defaults that do not fit a small window are clamped down instead of rejecting,
 *   - explicit overrides are still validated strictly,
 *   - per-field clamping lets a partial override resolve on a small window.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_BASELINE_TOKENS,
	DEFAULT_SPECS,
	levelFor,
	parseTokenSpec,
	resolveThresholds,
	validateSpecs,
	type ResolvedThresholds,
	type ThresholdSpecSources,
	type ThresholdSpecs,
} from "./thresholds.ts";

const MILLION = 1_000_000;
/** Context window reported by openai-codex/gpt-6-astra. */
const ASTRA_WINDOW = 272_000;

const ALL_DEFAULT: ThresholdSpecSources = { softAt: "default", at: "default", buffer: "default" };

function resolveOk(specs: ThresholdSpecs, window: number, sources?: ThresholdSpecSources): ResolvedThresholds {
	const result = sources ? resolveThresholds(specs, window, { sources }) : resolveThresholds(specs, window, { fromDefaults: false });
	if (!result.ok) throw new Error(result.error);
	return result.thresholds;
}

test("parseTokenSpec accepts whole tokens, k/m suffixes, and percentages", () => {
	assert.deepEqual(parseTokenSpec("270000", "x"), { kind: "tokens", value: 270000, raw: "270000" });
	assert.deepEqual(parseTokenSpec("100k", "x"), { kind: "tokens", value: 100000, raw: "100k" });
	assert.deepEqual(parseTokenSpec("1.5m", "x"), { kind: "tokens", value: 1500000, raw: "1.5m" });
	assert.deepEqual(parseTokenSpec(" 20% ", "x"), { kind: "percent", value: 20, raw: "20%" });
	assert.deepEqual(parseTokenSpec("0", "x"), { kind: "tokens", value: 0, raw: "0" });
	assert.deepEqual(parseTokenSpec("250K", "x"), { kind: "tokens", value: 250000, raw: "250K" });
});

test("parseTokenSpec rejects invalid values", () => {
	for (const bad of ["", "   ", "-1", "abc", "1.5", "150%", "10kk", "k", "%"]) {
		assert.throws(() => parseTokenSpec(bad, "--compact-at"), /Invalid --compact-at/, `expected rejection for ${JSON.stringify(bad)}`);
	}
});

test("shipped defaults are fixed tokens derived from the 1M baseline", () => {
	assert.equal(DEFAULT_BASELINE_TOKENS, 1_000_000);
	assert.deepEqual(DEFAULT_SPECS, { softAt: "100000", at: "200000", buffer: "100000" });
});

test("defaults resolve to 100k / 200k / 300k on a 1,000,000-token window", () => {
	const t = resolveOk(DEFAULT_SPECS, MILLION, ALL_DEFAULT);
	assert.equal(t.softTokens, 100_000);
	assert.equal(t.warnTokens, 200_000);
	assert.equal(t.bufferTokens, 100_000);
	assert.equal(t.forcedTokens, 300_000);
	assert.equal(t.capTokens, 900_000);
	assert.equal(t.softPct, 10);
	assert.equal(t.warnPct, 20);
	assert.equal(t.forcedPct, 30);
	assert.equal(t.clamped, false);
});

test("defaults on the 272,000-token gpt-6-astra window: 100k / 200k / 244,800 (90% cap)", () => {
	const t = resolveOk(DEFAULT_SPECS, ASTRA_WINDOW, ALL_DEFAULT);
	assert.equal(t.softTokens, 100_000);
	assert.equal(t.warnTokens, 200_000);
	assert.equal(t.forcedTokens, 244_800);
	assert.equal(t.capTokens, 244_800);
	assert.ok(Math.abs(t.softPct - 36.7647) < 0.01);
	assert.ok(Math.abs(t.warnPct - 73.5294) < 0.01);
	assert.equal(t.forcedPct, 90);
	assert.ok(t.notes.some((note) => note.includes("Forced threshold capped at 90%")));
	// The cap note is informational; only default clamps set `clamped`.
	assert.equal(t.clamped, false);
});

test("defaults that do not fit a small window are clamped down, not rejected", () => {
	const small = resolveOk(DEFAULT_SPECS, 128_000, ALL_DEFAULT);
	assert.equal(small.capTokens, 115_200);
	assert.equal(small.warnTokens, 115_200, "default warning clamps to the 90% cap");
	assert.equal(small.softTokens, 100_000, "default notice still fits below the clamped warning");
	assert.equal(small.forcedTokens, 115_200);
	assert.equal(small.clamped, true);
	assert.ok(small.notes.some((note) => note.includes("Default --compact-at")));

	const tiny = resolveOk(DEFAULT_SPECS, 64_000, ALL_DEFAULT);
	assert.equal(tiny.capTokens, 57_600);
	assert.equal(tiny.warnTokens, 57_600);
	assert.equal(tiny.softTokens, 57_600, "default notice clamps to the clamped warning");
	assert.equal(tiny.forcedTokens, 57_600);
	assert.equal(tiny.clamped, true);
});

test("small-window clamping is per field: a partial override still resolves", () => {
	// Only --compact-at is explicit; the defaulted notice line must clamp instead of making the extension inert.
	const sources: ThresholdSpecSources = { softAt: "default", at: "flag", buffer: "default" };
	const specs: ThresholdSpecs = { softAt: "100000", at: "50000", buffer: "100000" };
	assert.doesNotThrow(() => validateSpecs(specs, sources), "source-aware validation must not reject a defaulted field");
	const t = resolveOk(specs, ASTRA_WINDOW, sources);
	assert.equal(t.warnTokens, 50_000);
	assert.equal(t.softTokens, 50_000, "defaulted notice clamps to the explicit warning");
	assert.equal(t.clamped, true);
});

test("a defaulted warning clamps while an explicit notice below it survives", () => {
	const sources: ThresholdSpecSources = { softAt: "flag", at: "default", buffer: "default" };
	const specs: ThresholdSpecs = { softAt: "50000", at: "200000", buffer: "100000" };
	const t = resolveOk(specs, 128_000, sources);
	assert.equal(t.capTokens, 115_200);
	assert.equal(t.warnTokens, 115_200);
	assert.equal(t.softTokens, 50_000);
	assert.equal(t.forcedTokens, 115_200);
	assert.equal(t.clamped, true);
});

test("explicit overrides on a large window resolve exactly", () => {
	const tokens = resolveOk({ softAt: "100k", at: "200k", buffer: "50k" }, MILLION);
	assert.equal(tokens.softTokens, 100_000);
	assert.equal(tokens.warnTokens, 200_000);
	assert.equal(tokens.forcedTokens, 250_000);
	assert.equal(tokens.forcedPct, 25);

	const percent = resolveOk({ softAt: "20%", at: "50%", buffer: "10%" }, MILLION);
	assert.equal(percent.softTokens, 200_000);
	assert.equal(percent.warnTokens, 500_000);
	assert.equal(percent.forcedTokens, 600_000);
});

test("zero buffer makes forced coincide with warning (immediate enforcement)", () => {
	const t = resolveOk({ softAt: "20%", at: "50%", buffer: "0" }, MILLION);
	assert.equal(t.forcedTokens, t.warnTokens);
	assert.equal(levelFor(500_000, t), "forced");
	assert.equal(levelFor(499_999, t), "notice");
});

test("explicit warning above the cap is rejected", () => {
	assert.throws(() => validateSpecs({ softAt: "20%", at: "95%", buffer: "0" }), /above the 90% hard cap/);
	const r = resolveThresholds({ softAt: "100k", at: "950k", buffer: "0" }, MILLION);
	assert.equal(r.ok, false);
});

test("explicit soft above warning is rejected, but a defaulted soft is clamped", () => {
	assert.throws(() => validateSpecs({ softAt: "60%", at: "50%", buffer: "0" }), /must not exceed/);
	assert.throws(() => validateSpecs({ softAt: "300k", at: "200k", buffer: "0" }), /must not exceed/);

	// Explicit soft above a defaulted warning is a real user error and is rejected at load time.
	const explicitSoft: ThresholdSpecSources = { softAt: "flag", at: "default", buffer: "default" };
	assert.throws(() => validateSpecs({ softAt: "300k", at: "200k", buffer: "100k" }, explicitSoft), /must not exceed/);

	const r = resolveThresholds({ softAt: "60%", at: "500k", buffer: "0" }, MILLION);
	assert.equal(r.ok, false);
	if (!r.ok) assert.match(r.error, /must not exceed/);
});

test("the aggregate fromDefaults flag keeps the upstream all-or-nothing behaviour for callers without sources", () => {
	const clamped = resolveThresholds({ softAt: "225k", at: "250k", buffer: "20k" }, 200_000, { fromDefaults: true });
	assert.equal(clamped.ok, true);
	if (clamped.ok) {
		assert.equal(clamped.thresholds.capTokens, 180_000);
		assert.equal(clamped.thresholds.warnTokens, 180_000);
		assert.equal(clamped.thresholds.softTokens, 180_000);
		assert.equal(clamped.thresholds.forcedTokens, 180_000);
		assert.equal(clamped.thresholds.clamped, true);
	}
	// fromDefaults:false treats every field as explicit, so the same values are rejected on a small window.
	const strict = resolveThresholds(DEFAULT_SPECS, 128_000, { fromDefaults: false });
	assert.equal(strict.ok, false);
});

test("an unknown or zero window is unresolvable", () => {
	for (const window of [0, -1, Number.NaN]) {
		const r = resolveThresholds(DEFAULT_SPECS, window, { sources: ALL_DEFAULT });
		assert.equal(r.ok, false);
	}
});

test("levelFor maps tokens to levels and unknown for null", () => {
	const t = resolveOk({ softAt: "20%", at: "50%", buffer: "10%" }, 100_000);
	assert.equal(levelFor(null, t), "unknown");
	assert.equal(levelFor(0, t), "idle");
	assert.equal(levelFor(19_999, t), "idle");
	assert.equal(levelFor(20_000, t), "notice");
	assert.equal(levelFor(50_000, t), "warning");
	assert.equal(levelFor(59_999, t), "warning");
	assert.equal(levelFor(60_000, t), "forced");
	assert.equal(levelFor(100_000, t), "forced");
});
