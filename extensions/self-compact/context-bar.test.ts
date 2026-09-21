import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTokens, markerIndex, renderContextBar } from "./context-bar.ts";

test("DoD example: 40% used, half cached, thresholds 20/50/60", () => {
	const r = renderContextBar({ usedPct: 40, cachedPct: 20, softPct: 20, warnPct: 50, forcedPct: 60 });
	assert.equal(r.text, "[###~====-!-|--------] 40%");
	assert.equal(r.cells.length, 20);
	assert.equal(r.cells.filter((c) => c === "#").length, 3);
	assert.equal(r.cells.filter((c) => c === "=").length, 4);
	assert.equal(r.cells.filter((c) => c === "-").length, 10);
	assert.equal(r.cells[3], "~");
	assert.equal(r.cells[9], "!");
	assert.equal(r.cells[11], "|");
});

test("fixed 1M-baseline defaults (100k / 200k / 300k) sit at 10% / 20% / 30%", () => {
	assert.equal(markerIndex(10, 20), 1);
	assert.equal(markerIndex(20, 20), 3);
	assert.equal(markerIndex(30, 20), 5);
	const r = renderContextBar({ usedPct: null, softPct: 10, warnPct: 20, forcedPct: 30 });
	assert.equal(r.text, "[-~-!-|--------------] --%");
});

test("zero buffer shows a single | where warning and forced overlap", () => {
	const r = renderContextBar({ usedPct: 30, cachedPct: 0, softPct: 20, warnPct: 50, forcedPct: 50 });
	assert.equal(r.text, "[===~==---|----------] 30%");
	assert.equal(r.cells.filter((c) => c === "!").length, 0, "no separate warning glyph");
	assert.equal(r.cells[9], "|");
});

test("0% and 100% usage keep all markers visible", () => {
	const zero = renderContextBar({ usedPct: 0, cachedPct: 0, softPct: 20, warnPct: 50, forcedPct: 60 });
	assert.equal(zero.text, "[---~-----!-|--------] 0%");
	const full = renderContextBar({ usedPct: 100, cachedPct: 0, softPct: 20, warnPct: 50, forcedPct: 60 });
	assert.equal(full.text, "[===~=====!=|========] 100%");
	const fullCached = renderContextBar({ usedPct: 100, cachedPct: 100, softPct: 20, warnPct: 50, forcedPct: 60 });
	assert.equal(fullCached.text, "[###~#####!#|########] 100%");
});

test("cached share never exceeds used share", () => {
	const r = renderContextBar({ usedPct: 10, cachedPct: 80, softPct: 20, warnPct: 50, forcedPct: 60 });
	assert.equal(r.text, "[##-~-----!-|--------] 10%");
});

test("formatTokens", () => {
	assert.equal(formatTokens(950), "950");
	assert.equal(formatTokens(120_000), "120.0k");
	assert.equal(formatTokens(1_000_000), "1.00M");
	assert.equal(formatTokens(null), "?");
});
