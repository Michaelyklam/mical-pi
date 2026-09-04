import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const strings = (description: string) => Type.Optional(Type.Array(Type.String(), { description, maxItems: 10 }));

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "zvec_grep_search",
		label: "Zvec grep search",
		description: "Search an existing workspace index for semantic, relational, cross-file, or multi-hop evidence such as architecture, call chains, dependencies, lifecycle, data or control flow, design rationale, and comparisons. Use it when exact lookup alone cannot answer a workspace-grounded question. Results include bounded source snippets and query-group metadata; treat sufficient snippets as already-read evidence.",
		parameters: Type.Object({
			root: Type.String({ description: "Absolute path to the indexed workspace" }),
			query: Type.Optional(Type.String({ description: "One primary hybrid natural-language or exact query" })),
			queries: strings("Additional primary hybrid query groups"),
			fts: strings("Supplemental lexical routes for exact anchors such as symbols, flags, or error messages"),
			vector: strings("Supplemental semantic-only query groups"),
			fuse: Type.Optional(Type.Boolean({ description: "Fuse every query group into one ranked search plan" })),
			globs: strings("Ordered path glob filters"),
			fileTypes: strings("ripgrep file types to include"),
			preferSymbol: Type.Optional(Type.Boolean({ description: "Prefer exact indexed symbols" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Maximum results per query group" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!params.query && !params.queries?.length && !params.fts?.length && !params.vector?.length) {
				throw new Error("At least one query, queries, fts, or vector route is required");
			}
			const requestedRoot = await import("node:path").then(({ resolve }) => resolve(params.root));
			const workspaceRoot = await import("node:path").then(({ resolve }) => resolve(ctx.cwd));
			if (requestedRoot !== workspaceRoot) throw new Error(`root must be the current workspace: ${workspaceRoot}`);

			const args = ["query"];
			if (params.query) args.push("--hybrid", params.query);
			for (const query of params.queries ?? []) args.push("--hybrid", query);
			for (const query of params.fts ?? []) args.push("--fts", query);
			for (const query of params.vector ?? []) args.push("--vector", query);
			if (params.fuse) args.push("--fuse");
			for (const glob of params.globs ?? []) args.push("--glob", glob);
			for (const fileType of params.fileTypes ?? []) args.push("--type", fileType);
			if (params.preferSymbol) args.push("--prefer-symbol");
			args.push("--limit", String(params.limit ?? 7), "--preview", "short", "--refresh", "off", "--mode", "direct");

			const result = await pi.exec("zg", args, { cwd: workspaceRoot, signal, timeout: 120_000 });
			if (result.code !== 0) throw new Error(result.stderr.trim() || `zg exited with code ${result.code}`);
			const truncated = truncateHead(result.stdout, { maxLines: 500, maxBytes: 30_000 });
			let text = truncated.content.trim() || "No indexed matches.";
			if (truncated.truncated) text += "\n\n[Results truncated to 500 lines / 30KB.]";
			return { content: [{ type: "text", text }], details: { root: workspaceRoot } };
		},
	});
}
