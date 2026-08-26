import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import askUser from "./index.ts";

test("question dialog rerenders within a narrower terminal width", async () => {
	let tool: any;
	askUser({ registerTool(definition: unknown) { tool = definition; } } as any);

	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};

	const ctx = {
		mode: "tui",
		ui: {
			custom(factory: any) {
				const component = factory(
					{ requestRender() {} },
					theme,
					{},
					() => {},
				);
				component.render(180);
				const narrowLines = component.render(72);
				assert.ok(
					narrowLines.every((line: string) => visibleWidth(line) <= 72),
					`expected every line to fit 72 columns; widest was ${Math.max(...narrowLines.map(visibleWidth))}`,
				);
				return Promise.resolve(null);
			},
		},
	};

	await tool.execute(
		"call-1",
		{
			question: "How should PostgreSQL enforce candidate isolation?",
			options: [
				{ label: "RLS plus tenant-scoped application code", description: "Enforce isolation in both PostgreSQL and the careers services." },
				{ label: "Application checks only", description: "Use candidate_id filters in code without database row-level security." },
			],
		},
		new AbortController().signal,
		undefined,
		ctx,
	);
});
