/**
 * firecrawl-web — web search + page fetch for every pi session.
 *
 * pi ships no web tool at all (built-ins are read/bash/edit/write/grep/find/ls)
 * and has no MCP client, so this is a plain custom tool pair:
 *
 *   web_search  -> Firecrawl POST /v2/search   (discovery; optional inline content)
 *   web_fetch   -> Firecrawl POST /v2/scrape   (known URL -> clean markdown)
 *
 * Configuration is read at call time from ~/.pi/agent/firecrawl.env (or the
 * directory set by PI_CODING_AGENT_DIR), falling back to FIRECRAWL_API_URL and
 * FIRECRAWL_API_KEY. The local file must not be accessible by group/other.
 * Without configuration, the official SDK's keyless cloud tier is used.
 *
 * Cancellation caveat: the SDK accepts no AbortSignal, so pi's signal is honored
 * by racing it and returning control to the agent. The in-flight HTTP request is
 * not actually torn down; `timeout` bounds it server-side instead.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	defineTool,
	formatSize,
	truncateHead,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Server-side budget per Firecrawl call (ms). Also our effective wall clock. */
const SEARCH_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 45_000;

/** Per-result content budget when web_search is asked to include page text. */
const PER_RESULT_MAX_BYTES = 12_000;

/** Reuse Firecrawl's cache for repeat reads within this window (ms). */
const CACHE_MAX_AGE_MS = 10 * 60_000;

const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 20;

const CONFIG_FILE_NAME = "firecrawl.env";

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

type FirecrawlConfig = {
	apiKey?: string;
	apiUrl?: string;
};

function configPath(): string {
	const configDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
	return join(configDir, CONFIG_FILE_NAME);
}

function unquote(value: string): string {
	const trimmed = value.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function localConfig(): FirecrawlConfig {
	const path = configPath();
	let contents: string;
	try {
		const mode = statSync(path).mode & 0o777;
		if ((mode & 0o077) !== 0) {
			throw new Error(`${path} must have mode 0600 (or stricter)`);
		}
		contents = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}

	const values = new Map<string, string>();
	for (const line of contents.split(/\r?\n/)) {
		const match = line.match(/^\s*(?:export\s+)?(FIRECRAWL_API_(?:KEY|URL))=(.*)$/);
		if (match) values.set(match[1], unquote(match[2]));
	}
	return {
		apiKey: values.get("FIRECRAWL_API_KEY")?.trim() || undefined,
		apiUrl: values.get("FIRECRAWL_API_URL")?.trim() || undefined,
	};
}

function config(): FirecrawlConfig {
	const local = localConfig();
	return {
		apiKey: local.apiKey || process.env.FIRECRAWL_API_KEY?.trim(),
		apiUrl: local.apiUrl || process.env.FIRECRAWL_API_URL?.trim(),
	};
}

type SearchResult = {
	url?: string;
	title?: string;
	description?: string;
	markdown?: string;
	position?: number;
	category?: string;
};

/**
 * Imported lazily so sessions that never touch the web pay no startup cost,
 * and a missing/broken install degrades to one failing tool call rather than a
 * dead extension.
 */
async function client(): Promise<{ fc: any; keyed: boolean }> {
	const { apiKey, apiUrl } = config();
	let mod: any;
	try {
		mod = await import("firecrawl");
	} catch (error) {
		throw new Error(
			`firecrawl SDK not installed in mical-pi (${(error as Error).message}). ` +
				`Run: npm install --prefix ~/Coding/mical-pi`,
		);
	}
	const Client = mod.Firecrawl ?? mod.default;
	const options = {
		...(apiKey ? { apiKey } : {}),
		...(apiUrl ? { apiUrl: apiUrl.replace(/\/$/, "") } : {}),
	};
	return { fc: new Client(options), keyed: Boolean(apiKey) };
}

/** Honor pi's abort signal even though the SDK cannot cancel the request. */
function withSignal<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return work;
	if (signal.aborted) return Promise.reject(new Error("Cancelled"));
	return Promise.race([
		work,
		new Promise<never>((_resolve, reject) => {
			signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
		}),
	]);
}

function explain(error: unknown, keyed: boolean): string {
	const message = error instanceof Error ? error.message : String(error);
	if (/\b429\b|rate limit/i.test(message) && !keyed) {
		return `${message}\n\nThis is Firecrawl's keyless free tier. Configure FIRECRAWL_API_KEY for higher limits.`;
	}
	if (/\b401\b|\b403\b|unauthor/i.test(message) && keyed) {
		return `${message}\n\nFIRECRAWL_API_KEY looks invalid or lacks access to this endpoint.`;
	}
	return message;
}

function clip(text: string, maxBytes: number): string {
	const t = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes });
	return t.truncated ? `${t.content}\n[...truncated at ${formatSize(maxBytes)}]` : t.content;
}

// ---------------------------------------------------------------------------
// web_search
// ---------------------------------------------------------------------------

const searchTool = defineTool({
	name: "web_search",
	label: "Web Search",
	description:
		"Search the live web via Firecrawl. Returns ranked results with title, URL and " +
		"a snippet. Set includeContent to also pull each page's full text as markdown in " +
		"the same call, which avoids a follow-up web_fetch when you need to read the results.",
	promptSnippet: "Search the live web for current information and return ranked results",
	promptGuidelines: [
		"Use web_search when the answer depends on current or external information (docs, releases, APIs, error messages) rather than the local repo.",
		"Prefer web_search with includeContent: true over web_search followed by several web_fetch calls.",
	],
	parameters: Type.Object({
		query: Type.String({ description: "Search query" }),
		limit: Type.Optional(
			Type.Number({
				description: `Max results (1-${MAX_SEARCH_LIMIT}, default ${DEFAULT_SEARCH_LIMIT})`,
			}),
		),
		includeContent: Type.Optional(
			Type.Boolean({
				description: "Also return each result's page content as markdown. Slower. Default false.",
			}),
		),
		includeDomains: Type.Optional(
			Type.Array(Type.String(), { description: "Restrict results to these domains" }),
		),
		excludeDomains: Type.Optional(
			Type.Array(Type.String(), { description: "Omit results from these domains" }),
		),
	}),

	async execute(_toolCallId, params, signal, onUpdate, _ctx) {
		const query = params.query.trim();
		if (!query) throw new Error("query must not be empty");

		const limit = Math.min(Math.max(Math.trunc(params.limit ?? DEFAULT_SEARCH_LIMIT), 1), MAX_SEARCH_LIMIT);
		const { fc, keyed } = await client();

		onUpdate?.({ content: [{ type: "text", text: `Searching: ${query}` }], details: {} });

		let data: { web?: SearchResult[] };
		try {
			data = await withSignal(
				fc.search(query, {
					limit,
					timeout: SEARCH_TIMEOUT_MS,
					...(params.includeDomains?.length ? { includeDomains: params.includeDomains } : {}),
					...(params.excludeDomains?.length ? { excludeDomains: params.excludeDomains } : {}),
					...(params.includeContent
						? {
								scrapeOptions: {
									formats: ["markdown"],
									onlyMainContent: true,
									maxAge: CACHE_MAX_AGE_MS,
								},
							}
						: {}),
				}),
				signal,
			);
		} catch (error) {
			throw new Error(explain(error, keyed));
		}

		const results = data.web ?? [];
		if (results.length === 0) {
			return {
				content: [{ type: "text", text: `No results for: ${query}` }],
				details: { query, count: 0, keyed },
			};
		}

		const body = results
			.map((r, i) => {
				const head = `${i + 1}. ${r.title ?? "(untitled)"}\n   ${r.url ?? "(no url)"}`;
				const snippet = r.description?.trim();
				const content = params.includeContent ? r.markdown?.trim() : undefined;
				return [
					head,
					snippet ? `   ${clip(snippet, 600).replace(/\n/g, "\n   ")}` : undefined,
					content ? `\n--- content: ${r.url} ---\n${clip(content, PER_RESULT_MAX_BYTES)}` : undefined,
				]
					.filter(Boolean)
					.join("\n");
			})
			.join("\n\n");

		return {
			content: [
				{
					type: "text",
					text: clip(`${results.length} result(s) for "${query}":\n\n${body}`, DEFAULT_MAX_BYTES),
				},
			],
			details: {
				query,
				count: results.length,
				keyed,
				urls: results.map((r) => r.url).filter(Boolean),
			},
		};
	},
});

// ---------------------------------------------------------------------------
// web_fetch
// ---------------------------------------------------------------------------

const fetchTool = defineTool({
	name: "web_fetch",
	label: "Web Fetch",
	description:
		"Fetch a single URL and return its content as clean markdown via Firecrawl. " +
		"Handles JS-rendered pages and public document URLs (PDF, DOCX). Use web_search " +
		"first when you do not already have the URL.",
	promptSnippet: "Fetch a known URL and return its content as clean markdown",
	promptGuidelines: [
		"Use web_fetch when you already have a URL and need its contents; do not guess at page text from a search snippet alone.",
	],
	parameters: Type.Object({
		url: Type.String({ description: "Absolute URL to fetch" }),
		onlyMainContent: Type.Optional(
			Type.Boolean({
				description: "Strip nav/footer/boilerplate and keep the main article. Default true.",
			}),
		),
	}),

	async execute(_toolCallId, params, signal, onUpdate, _ctx) {
		// Some models prefix path/URL args with '@'; built-in tools strip it, so do the same.
		const url = params.url.trim().replace(/^@/, "");
		if (!/^https?:\/\//i.test(url)) {
			throw new Error(`url must be an absolute http(s) URL, got: ${params.url}`);
		}

		const { fc, keyed } = await client();
		onUpdate?.({ content: [{ type: "text", text: `Fetching: ${url}` }], details: {} });

		let doc: { markdown?: string; metadata?: Record<string, unknown> };
		try {
			doc = await withSignal(
				fc.scrape(url, {
					formats: ["markdown"],
					onlyMainContent: params.onlyMainContent ?? true,
					timeout: FETCH_TIMEOUT_MS,
					maxAge: CACHE_MAX_AGE_MS,
				}),
				signal,
			);
		} catch (error) {
			throw new Error(explain(error, keyed));
		}

		const markdown = doc.markdown?.trim();
		if (!markdown) {
			throw new Error(`Firecrawl returned no markdown content for ${url}`);
		}

		const title = (doc.metadata?.title as string | undefined)?.trim();
		const header = title ? `# ${title}\n<${url}>\n\n` : `<${url}>\n\n`;

		return {
			content: [{ type: "text", text: clip(header + markdown, DEFAULT_MAX_BYTES) }],
			details: { url, title, bytes: markdown.length, keyed },
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(searchTool);
	pi.registerTool(fetchTool);
}
