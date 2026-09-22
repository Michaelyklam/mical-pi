import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { formatActivityStatus } from "../subagents/src/format.ts";
import { renderFooterLines, type FooterViewModel } from "./ui/footer.ts";

const theme = { fg: (_role: string, text: string) => text };
const base: FooterViewModel = {
	accountLabel: "personal",
	contextTokens: 72_500,
	contextWindowTokens: 371_000,
	branch: "main",
	git: { insertions: 12, deletions: 4 },
	cost: { reported: 0, estimated: 0.33, hasReportedUsage: false, hasEstimatedUsage: true, hasUnpricedUsage: false },
	usage: {
		status: "live",
		windows: [
			{ id: "short", label: "5h", usedPercent: 43, kind: "primary" },
			{ id: "long", label: "7d", usedPercent: 91, kind: "secondary" },
		],
	},
};

test("wide footer puts account, status, cost, and usage above context and git metadata", () => {
	const lines = renderFooterLines({ ...base, statuses: ["plugin warning"] }, 140, theme);
	assert.equal(lines.length, 2);
	assert.match(lines[0]!, /^personal.*plugin warning.*Est: ~\$0\.33/);
	assert.doesNotMatch(lines[0]!, /Model:|gpt-5\.6-sol|openai-codex/);
	assert.match(lines[0]!, /5h ██░░░ 43%.*7d █████ 91%/);
	assert.match(lines[1]!, /^Ctx: 72\.5k\/371k.*⎇ main.*\(\+12,-4\)/);
});

test("git metadata shows the repository name alongside its branch", () => {
	const line = renderFooterLines({ ...base, repoName: "mical-pi" }, 140, theme)[1]!;
	assert.match(line, /⎇ mical-pi\/main/);
	const detached = renderFooterLines({ ...base, repoName: "mical-pi", branch: null }, 140, theme)[1]!;
	assert.match(detached, /⎇ mical-pi/);
	assert.doesNotMatch(detached, /mical-pi\//);
	for (const width of [23, 40, 60]) {
		for (const row of renderFooterLines({ ...base, repoName: "mical-pi" }, width, theme)) {
			assert.ok(visibleWidth(row) <= width);
		}
	}
});

test("subagent and workflow activity gets a dedicated row below account information", () => {
	const lines = renderFooterLines({
		...base,
		statuses: ["plugin warning"],
		agentStatuses: ["subagents: 12 running", "workflows: 2 running"],
		subagentCostUsd: 0.127,
	}, 140, theme);
	assert.equal(lines.length, 3);
	assert.match(lines[0]!, /^personal.*plugin warning.*Est: ~\$0\.33/);
	assert.doesNotMatch(lines[0]!, /subagents|workflows|Subagents:/i);
	assert.match(lines[1]!, /subagents: 12 running.*workflows: 2 running.*\[Est: ~\$0\.13\]/);
	assert.match(lines[2]!, /^Ctx: 72\.5k\/371k.*⎇ main.*\(\+12,-4\)/);
});

test("subagent row uses compact counts, fixed colors, and a compact cost", () => {
	const status = formatActivityStatus(theme as Parameters<typeof formatActivityStatus>[0], { running: 5, done: 2, failed: 1 });
	const line = renderFooterLines({ ...base, agentStatuses: [status], subagentCostUsd: 138.34 }, 140, theme)[1]!;
	assert.equal(stripVTControlCharacters(line), "subagents 5/3 [Est: ~$138.34]");
	assert.ok(line.includes("\x1b[1;92m5\x1b[22;39m"));
	assert.ok(line.includes("\x1b[38;2;128;128;128m3\x1b[39m"));
	const idle = formatActivityStatus(theme as Parameters<typeof formatActivityStatus>[0], { running: 0, done: 8, failed: 0 });
	assert.equal(stripVTControlCharacters(idle), "subagents 0/8");
});

test("constrained footer moves all usage windows below account and statuses", () => {
	const lines = renderFooterLines({ ...base, statuses: ["plugin warning"] }, 58, theme);
	assert.match(lines[0]!, /personal.*plugin warning/);
	assert.match(lines[1]!, /Usage: 5h ██░░░ 43%.*7d █████ 91%/);
	assert.match(lines[2]!, /Ctx: 72\.5k\/371k.*⎇ main.*\(\+12,-4\)/);
	for (const line of lines) assert.ok(visibleWidth(line) <= 58);
});

test("narrow footer preserves account, every usage window, and context", () => {
	const lines = renderFooterLines(base, 32, theme);
	assert.equal(lines.length, 4);
	assert.match(lines[0]!, /^personal/);
	assert.match(lines[1]!, /^Usage: 5h ██░░░ 43%$/);
	assert.match(lines[2]!, /^Usage: 7d █████ 91%$/);
	assert.match(lines[3]!, /^Ctx: 72\.5k\/371k \| ⎇ main$/);
	for (const line of lines) assert.ok(visibleWidth(line) <= 32);
});

test("host telemetry follows the requested order and hides fields from right to left", () => {
	const host = { agents: 9, agentActivity: { active: 6, idle: 3, total: 9 }, cpuPercent: 63, ramPercent: 71, gpuPercent: 84 };
	const wide = renderFooterLines({ ...base, host }, 100, theme)[1]!;
	assert.match(wide, /Agents: \x1b\[1;92m6\x1b\[22;39m\/3/);
	const ordered = ["Ctx:", "⎇ main", "(+12,-4)", "Agents:", "CPU: 63%", "RAM: 71%", "GPU: 84%"];
	for (let index = 1; index < ordered.length; index++) {
		assert.ok(wide.indexOf(ordered[index - 1]!) < wide.indexOf(ordered[index]!));
	}

	const cases = [
		{ width: 79, kept: "RAM: 71%", hidden: "GPU:" },
		{ width: 68, kept: "CPU: 63%", hidden: "RAM:" },
		{ width: 57, kept: "Agents:", hidden: "CPU:" },
		{ width: 46, kept: "(+12,-4)", hidden: "Agents:" },
		{ width: 34, kept: "⎇ main", hidden: "(+12,-4)" },
		{ width: 23, kept: "Ctx:", hidden: "⎇ main" },
	];
	for (const entry of cases) {
		const line = renderFooterLines({ ...base, host }, entry.width, theme).at(-1)!;
		assert.match(line, new RegExp(entry.kept.replace(/[()+-]/g, "\\$&")));
		assert.doesNotMatch(line, new RegExp(entry.hidden.replace(/[()+-]/g, "\\$&")));
		assert.ok(visibleWidth(line) <= entry.width);
	}
});

test("usage windows show time until reset instead of the window length", () => {
	const now = Date.parse("2026-09-02T12:00:00Z");
	const minute = 60_000;
	const lines = renderFooterLines({
		...base,
		usage: {
			status: "live",
			windows: [
				{ id: "short", label: "5h", usedPercent: 43, kind: "primary", resetsAt: now + 135 * minute },
				{ id: "long", label: "7d", usedPercent: 91, kind: "secondary", resetsAt: now + (3 * 1440 + 4 * 60) * minute },
				{ id: "soon", label: "5h", usedPercent: 10, kind: "model", resetsAt: now + 40 * minute },
				{ id: "spend", label: "month", usedPercent: 20, kind: "spend" },
			],
		},
	}, 200, theme, now);
	assert.match(lines[0]!, /2h 15m ██░░░ 43%.*3d 4h █████ 91%.*40m █░░░░ 10%.*month █░░░░ 20%/);
	assert.doesNotMatch(lines[0]!, /5h |7d /);

	const expired = renderFooterLines({
		...base,
		usage: { status: "live", windows: [{ id: "short", label: "5h", usedPercent: 99, kind: "primary", resetsAt: now - minute }] },
	}, 200, theme, now);
	assert.match(expired[0]!, /resetting █████ 99%/);
});

test("subscription bars and reset countdowns survive long statuses in tmux panes", () => {
	const now = Date.parse("2026-09-21T12:00:00Z");
	const view: FooterViewModel = {
		...base,
		accountLabel: "personal subscription account",
		statuses: ["plugin synchronization waiting for network"],
		usage: {
			status: "live",
			windows: [
				{ id: "short", label: "5h", usedPercent: 43, kind: "primary", resetsAt: now + 135 * 60_000 },
				{ id: "long", label: "7d", usedPercent: 78, kind: "secondary", resetsAt: now + (3 * 1440 + 4 * 60) * 60_000 },
			],
		},
	};
	for (const width of [32, 58, 80]) {
		const lines = renderFooterLines(view, width, theme, now);
		const rendered = lines.join("\n");
		assert.match(rendered, /2h 15m ██░░░ 43%/);
		assert.match(rendered, /3d 4h ████░ 78%/);
		for (const line of lines) assert.ok(visibleWidth(line) <= width);
	}
});

test("reported and estimated costs stay separate, including zero and sub-cent charges", () => {
	const lines = renderFooterLines({
		...base,
		cost: { ...base.cost, reported: 0.000364, hasReportedUsage: true },
		agentStatuses: ["subagents 1/0"],
		subagentCostUsd: 0.7,
		subagentReportedCostUsd: 0.5,
		subagentEstimatedCostUsd: 0.2,
	}, 160, theme);
	assert.match(lines[0]!, /Cost: \$0\.000364 \+ Est: ~\$0\.33/);
	assert.match(lines[1]!, /\[Cost: \$0\.50 \+ Est: ~\$0\.20\]/);
	const free = renderFooterLines({
		...base,
		cost: { reported: 0, estimated: 0, hasReportedUsage: true, hasEstimatedUsage: false, hasUnpricedUsage: false },
		subagentReportedCostUsd: 0,
	}, 160, theme);
	assert.match(free[0]!, /Cost: \$0\.00/);
	assert.doesNotMatch(free.join("\n"), /Est:/);
	assert.match(free[1]!, /\[Cost: \$0\.00\]/);
});

test("footer distinguishes stale and local fallback states and missing prices", () => {
	const stale = renderFooterLines({ ...base, usage: { ...base.usage, status: "stale" } }, 120, theme);
	assert.match(stale[0]!, /\(stale\)/);
	const local = renderFooterLines({
		...base,
		cost: { reported: 0, estimated: 0, hasReportedUsage: false, hasEstimatedUsage: true, hasUnpricedUsage: true },
		usage: { status: "local", windows: [], local: { tokens: 8_400_000, estimated: 12.3, hasUnpricedUsage: false, models: 2 } },
	}, 120, theme);
	assert.match(local[0]!, /Est: n\/a/);
	assert.match(local[0]!, /Usage \(local today\): 8\.4M tok · ~\$12\.30 est/);
});
