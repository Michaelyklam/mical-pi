import assert from "node:assert/strict";
import { test } from "node:test";
import { buildZgArgs, buildZgIndexArgs } from "./index.ts";

test("buildZgIndexArgs uses local embeddings without destructive flags", () => {
	const args = buildZgIndexArgs();
	assert.deepEqual(args, ["index", ".", "--embedding", "local/potion-code-16m-v2", "--mode", "direct"]);
	assert.ok(!args.includes("--rebuild"));
	assert.ok(!args.includes("--drop"));
});

test("buildZgArgs maps all search routes and production freshness", () => {
	assert.deepEqual(buildZgArgs({
		root: "/repo",
		query: "playback ownership",
		queries: ["writer sequencing"],
		fts: ["leaderLeaseId"],
		vector: ["stale clients"],
		fuse: true,
		globs: ["convex/**"],
		fileTypes: ["ts"],
		preferSymbol: true,
		limit: 9,
	}), [
		"query",
		"--hybrid", "playback ownership",
		"--hybrid", "writer sequencing",
		"--fts", "leaderLeaseId",
		"--vector", "stale clients",
		"--fuse",
		"--glob", "convex/**",
		"--type", "ts",
		"--prefer-symbol",
		"--limit", "9",
		"--preview", "short",
		"--refresh", "wait",
		"--mode", "direct",
	]);
});

test("buildZgArgs defaults to seven results", () => {
	assert.deepEqual(buildZgArgs({ root: "/repo", query: "authentication flow" }).slice(-8), [
		"--limit", "7", "--preview", "short", "--refresh", "wait", "--mode", "direct",
	]);
});
