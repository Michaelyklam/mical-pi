import assert from "node:assert/strict";
import test from "node:test";
import { formatElapsedTime } from "./index.ts";

test("formatElapsedTime renders a zero-padded clock", () => {
	assert.equal(formatElapsedTime(0), "00:00:00");
	assert.equal(formatElapsedTime(999), "00:00:00");
	assert.equal(formatElapsedTime(1_000), "00:00:01");
	assert.equal(formatElapsedTime(61_000), "00:01:01");
	assert.equal(formatElapsedTime(3_661_000), "01:01:01");
});

test("formatElapsedTime supports long and invalid negative durations", () => {
	assert.equal(formatElapsedTime(360_000_000), "100:00:00");
	assert.equal(formatElapsedTime(-1_000), "00:00:00");
});
