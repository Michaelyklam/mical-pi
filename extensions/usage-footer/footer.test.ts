import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderFooterLines, type FooterViewModel } from "./ui/footer.ts";

const theme = { fg: (_role: string, text: string) => text };
const base: FooterViewModel = {
	providerId: "openai-codex",
	modelId: "gpt-5.6-sol",
	accountLabel: "personal",
	contextTokens: 72_500,
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

test("wide footer renders identity, coding context, cost, and colored five-cell windows", () => {
	const lines = renderFooterLines(base, 140, theme);
	assert.equal(lines.length, 2);
	assert.match(lines[0]!, /Model: openai-codex\/gpt-5\.6-sol · personal/);
	assert.match(lines[0]!, /Ctx: 72\.5k.*⎇ main.*\(\+12,-4\)/);
	assert.match(lines[1]!, /Est: ~\$0\.33/);
	assert.match(lines[1]!, /5h ██░░░ 43%.*7d █████ 91%/);
});

test("narrow footer preserves provider and account, drops cost, and keeps most utilized window", () => {
	const lines = renderFooterLines(base, 32, theme);
	assert.equal(lines.length, 2);
	assert.match(lines[0]!, /openai-codex\/.*….* · personal/);
	assert.doesNotMatch(lines[1]!, /Est:/);
	assert.match(lines[1]!, /7d █████ 91%/);
	for (const line of lines) assert.ok(visibleWidth(line) <= 32);
});

test("footer distinguishes stale and local fallback states and missing prices", () => {
	const stale = renderFooterLines({ ...base, usage: { ...base.usage, status: "stale" } }, 120, theme);
	assert.match(stale[1]!, /\(stale\)/);
	const local = renderFooterLines({
		...base,
		cost: { reported: 0, estimated: 0, hasEstimatedUsage: true, hasUnpricedUsage: true },
		usage: { status: "local", windows: [], local: { tokens: 8_400_000, estimated: 12.3, hasUnpricedUsage: false, models: 2 } },
	}, 120, theme);
	assert.match(local[1]!, /Est: n\/a/);
	assert.match(local[1]!, /Usage \(local today\): 8\.4M tok · ~\$12\.30 est/);
});
