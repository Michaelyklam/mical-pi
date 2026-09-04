import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const strings = (description: string) => Type.Optional(Type.Array(Type.String(), { description, maxItems: 10 }));

export interface ZgSearchInput {
	root: string;
	query?: string;
	queries?: string[];
	fts?: string[];
	vector?: string[];
	fuse?: boolean;
	globs?: string[];
	fileTypes?: string[];
	preferSymbol?: boolean;
	limit?: number;
}

export function buildZgIndexArgs(): string[] {
	return ["index", ".", "--embedding", "local/potion-code-16m-v2", "--mode", "direct"];
}

export function buildZgArgs(params: ZgSearchInput): string[] {
	const args = ["query"];
	if (params.query) args.push("--hybrid", params.query);
	for (const query of params.queries ?? []) args.push("--hybrid", query);
	for (const query of params.fts ?? []) args.push("--fts", query);
	for (const query of params.vector ?? []) args.push("--vector", query);
	if (params.fuse) args.push("--fuse");
	for (const glob of params.globs ?? []) args.push("--glob", glob);
	for (const fileType of params.fileTypes ?? []) args.push("--type", fileType);
	if (params.preferSymbol) args.push("--prefer-symbol");
	args.push("--limit", String(params.limit ?? 7), "--preview", "short", "--refresh", "wait", "--mode", "direct");
	return args;
}

export default function (pi: ExtensionAPI) {
	let registered = false;
	pi.on("session_start", () => {
		if (registered) return;
		registered = true;

		pi.registerTool({
			name: "zvec_grep_index",
			label: "Zvec grep index",
			description: "Create a local zvec-grep index for the current workspace when repository retrieval is needed and no index exists. Uses local Potion embeddings and honors repository ignore rules. Does not rebuild or delete an existing index.",
			promptSnippet: "Create the current workspace's local semantic-search index when one is required but missing",
			promptGuidelines: [
				"Call zvec_grep_index when workspace retrieval is needed and zvec_grep_search reports that the current repository has no index. Do not index unrelated workspaces preemptively.",
				"Never rebuild or delete an existing zvec-grep index unless the user explicitly requests it.",
			],
			parameters: Type.Object({
				root: Type.String({ description: "Absolute path to the current workspace" }),
			}),
			async execute(_toolCallId, params, signal, _onUpdate, toolContext) {
				const requestedRoot = resolve(params.root);
				const workspaceRoot = resolve(toolContext.cwd);
				if (requestedRoot !== workspaceRoot) throw new Error(`root must be the current workspace: ${workspaceRoot}`);
				if (existsSync(resolve(workspaceRoot, ".zvec-grep", "manifest.json"))) {
					return {
						content: [{ type: "text", text: "The current workspace already has a zvec-grep index. Use zvec_grep_search; searches refresh it incrementally." }],
						details: { root: workspaceRoot, created: false },
					};
				}

				const result = await pi.exec("zg", buildZgIndexArgs(), { cwd: workspaceRoot, signal, timeout: 600_000 });
				if (result.code !== 0) throw new Error(result.stderr.trim() || `zg exited with code ${result.code}`);
				const truncated = truncateHead(result.stdout, { maxLines: 200, maxBytes: 20_000 });
				return {
					content: [{ type: "text", text: `${truncated.content.trim()}\n\nIndex ready. Continue with zvec_grep_search.` }],
					details: { root: workspaceRoot, created: true },
				};
			},
		});

		pi.registerTool({
			name: "zvec_grep_search",
			label: "Zvec grep search",
			description: "Search an existing workspace index for semantic, relational, cross-file, or multi-hop evidence such as architecture, call chains, dependencies, lifecycle, data or control flow, design rationale, and comparisons. Use it when exact lookup alone cannot answer a workspace-grounded question. Results include bounded source snippets and query-group metadata; treat sufficient snippets as already-read evidence.",
			promptSnippet: "Search the indexed workspace by meaning and retrieve ranked source excerpts",
			promptGuidelines: [
				"Use zvec_grep_search when wording or location is unknown, or when a workspace question requires semantic discovery, relationships, architecture, data or control flow, or cross-file synthesis. Use grep for sufficient exact-word, symbol, path, or regex lookup.",
				"For mixed tasks, start with zvec_grep_search using the concept and known anchors, then use grep or read only for focused verification.",
				"Treat sufficient zvec_grep_search source snippets as already-read evidence and stop searching once the available evidence answers the question.",
				"If zvec_grep_search reports that no index exists and workspace retrieval is needed, call zvec_grep_index for the current workspace, then retry the search.",
			],
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
			async execute(_toolCallId, params, signal, _onUpdate, toolContext) {
				if (!params.query && !params.queries?.length && !params.fts?.length && !params.vector?.length) {
					throw new Error("At least one query, queries, fts, or vector route is required");
				}
				const requestedRoot = resolve(params.root);
				const workspaceRoot = resolve(toolContext.cwd);
				if (requestedRoot !== workspaceRoot) throw new Error(`root must be the current workspace: ${workspaceRoot}`);
				if (!existsSync(resolve(workspaceRoot, ".zvec-grep", "manifest.json"))) {
					return {
						content: [{ type: "text", text: "No zvec-grep index exists for this workspace. Call zvec_grep_index with the same root, then retry this search." }],
						details: { root: workspaceRoot, indexRequired: true },
					};
				}

				const result = await pi.exec("zg", buildZgArgs(params), { cwd: workspaceRoot, signal, timeout: 120_000 });
				if (result.code !== 0) throw new Error(result.stderr.trim() || `zg exited with code ${result.code}`);
				const truncated = truncateHead(result.stdout, { maxLines: 500, maxBytes: 30_000 });
				let text = truncated.content.trim() || "No indexed matches.";
				if (truncated.truncated) text += "\n\n[Results truncated to 500 lines / 30KB.]";
				return {
					content: [{ type: "text", text }],
					details: { root: workspaceRoot, stderr: result.stderr.trim() || undefined },
				};
			},
		});
	});
}
