import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderFooterLines, type FooterViewModel } from "./ui/footer.ts";

const theme = { fg: (_role: string, text: string) => text };
const base: FooterViewModel = {
	modelId: "gpt-5.6-sol",
	accountLabel: "personal",
	contextTokens: 72_500,
	contextWindowTokens: 371_000,
	branch: "main",
	git: { insertions: 12, deletions: 4 },
	cost: { reported: 0, estimated: 0.33, hasEstimatedUsage: true, hasUnpricedUsage: false },
	usage: {
		status: "live",
		windows: [
			{ id: "short", label: "5h", usedPercent: 43, kind: "primary" },
			{ id: "long", label: "7d", usedPercent: 91, kind: "secondary" },
		],
	},
};

test("wide footer puts model, status, cost, and usage above context and git metadata", () => {
	const lines = renderFooterLines({ ...base, statuses: ["⚡ fast"] }, 140, theme);
	assert.equal(lines.length, 2);
	assert.match(lines[0]!, /^Model: gpt-5\.6-sol · personal.*⚡ fast.*Est: ~\$0\.33/);
	assert.doesNotMatch(lines[0]!, /openai-codex/);
	assert.match(lines[0]!, /5h ██░░░ 43%.*7d █████ 91%/);
	assert.match(lines[1]!, /^Ctx: 72\.5k\/371k.*⎇ main.*\(\+12,-4\)/);
});

test("subagent and workflow activity gets a dedicated row below model information", () => {
	const lines = renderFooterLines({
		...base,
		statuses: ["⚡ fast"],
		agentStatuses: ["subagents: 12 running", "workflows: 2 running"],
		subagentCostUsd: 0.127,
	}, 140, theme);
	assert.equal(lines.length, 3);
	assert.match(lines[0]!, /^Model: gpt-5\.6-sol · personal.*⚡ fast.*Est: ~\$0\.33/);
	assert.doesNotMatch(lines[0]!, /subagents|workflows|Subagents:/i);
	assert.match(lines[1]!, /subagents: 12 running.*workflows: 2 running.*\[Subagents: \$0\.13\]/);
	assert.match(lines[2]!, /^Ctx: 72\.5k\/371k.*⎇ main.*\(\+12,-4\)/);
});

test("constrained footer prioritizes extension statuses and context over optional details", () => {
	const lines = renderFooterLines({ ...base, statuses: ["⚡ fast"] }, 58, theme);
	assert.match(lines[0]!, /Model: gpt-5\.6-sol · personal.*⚡ fast/);
	assert.doesNotMatch(lines[0]!, /Est:|Usage:/);
	assert.match(lines[1]!, /Ctx: 72\.5k\/371k.*⎇ main.*\(\+12,-4\)/);
	for (const line of lines) assert.ok(visibleWidth(line) <= 58);
});

test("narrow footer preserves model, account, and context", () => {
	const lines = renderFooterLines(base, 32, theme);
	assert.equal(lines.length, 2);
	assert.match(lines[0]!, /^Model: gpt-5\.6-sol · personal$/);
	assert.match(lines[1]!, /^Ctx: 72\.5k\/371k \| ⎇ main$/);
	for (const line of lines) assert.ok(visibleWidth(line) <= 32);
});

test("footer distinguishes stale and local fallback states and missing prices", () => {
	const stale = renderFooterLines({ ...base, usage: { ...base.usage, status: "stale" } }, 120, theme);
	assert.match(stale[0]!, /\(stale\)/);
	const local = renderFooterLines({
		...base,
		cost: { reported: 0, estimated: 0, hasEstimatedUsage: true, hasUnpricedUsage: true },
		usage: { status: "local", windows: [], local: { tokens: 8_400_000, estimated: 12.3, hasUnpricedUsage: false, models: 2 } },
	}, 120, theme);
	assert.match(local[0]!, /Est: n\/a/);
	assert.match(local[0]!, /Usage \(local today\): 8\.4M tok · ~\$12\.30 est/);
});
