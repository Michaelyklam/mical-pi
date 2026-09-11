import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cpuPercent, linuxRamPercent, macRamPercent } from "../host-telemetry/metrics.ts";
import { AgentRegistry } from "../host-telemetry/registry.ts";

test("CPU utilization uses the delta between samples", () => {
	assert.equal(cpuPercent({ idle: 100, total: 400 }, { idle: 175, total: 500 }), 25);
	assert.equal(cpuPercent({ idle: 100, total: 400 }, { idle: 100, total: 400 }), undefined);
});

test("Linux RAM utilization uses MemAvailable", () => {
	const meminfo = [
		"MemTotal:       1000000 kB",
		"MemFree:         100000 kB",
		"MemAvailable:    250000 kB",
	].join("\n");
	assert.equal(linuxRamPercent(meminfo), 75);
});

test("macOS RAM utilization treats free, inactive, and speculative pages as reclaimable", () => {
	const vmStat = [
		"Mach Virtual Memory Statistics: (page size of 4096 bytes)",
		"Pages free:                               100.",
		"Pages inactive:                           100.",
		"Pages speculative:                         50.",
	].join("\n");
	assert.equal(macRamPercent(vmStat, 1000 * 4096), 75);
});

test("agent registry sums Pi sessions and their children and removes stale leases", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mical-pi-agents-"));
	try {
		const alive = () => true;
		const first = new AgentRegistry("one", directory, 1001, alive);
		const second = new AgentRegistry("two", directory, 1002, alive);
		await first.heartbeat(3, 10_000);
		await second.heartbeat(2, 10_000);
		assert.equal(await first.count(10_000), 7);

		await second.heartbeat(2, 6_000);
		assert.equal(await first.count(10_000), 4);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
