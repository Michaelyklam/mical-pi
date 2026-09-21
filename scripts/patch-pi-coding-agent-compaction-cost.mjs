#!/usr/bin/env node
/**
 * Maintained patch: preserve per-call billing across a split compaction.
 *
 * `combineUsage` in `@earendil-works/pi-coding-agent` merges the usage of two
 * summarization calls (history summary + turn prefix summary) into a fresh
 * object that copies only token counters and `cost`, dropping anything else.
 * Once `scripts/patch-pi-ai-openrouter-cost.mjs` preserves a router charge on
 * `usage.reportedCost`, a split compaction would lose it: the merged usage has
 * no `reportedCost`, so accounting falls back to the merged estimate and labels
 * a genuinely reported part as estimated.
 *
 * This patch keeps each underlying call on `usage.billingComponents`, so
 * `extensions/shared/billing.ts` can account the two calls separately. The
 * merged usage itself is never treated as the authoritative total.
 *
 * Patches BOTH the repo-local copies and the host/global install, in the
 * unbundled dist and the minified host bundle. Idempotent. Remove once fixed
 * upstream in pi-coding-agent.
 *
 * Usage:
 *   node scripts/patch-pi-coding-agent-compaction-cost.mjs           # apply (idempotent)
 *   node scripts/patch-pi-coding-agent-compaction-cost.mjs --check   # verify, exit 1 if stale
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MARKER = "PI_BILLING_COMPONENTS_PATCH";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Unbundled dist: the tail of `combineUsage`'s returned object.
export const PRETTY_ANCHOR = `            total: first.cost.total + second.cost.total,
        },
    };
}`;

export const PRETTY_PATCH = `            total: first.cost.total + second.cost.total,
        },
        // ${MARKER}: a split compaction merges two summarization calls into one
        // usage. Preserve each call so a provider-reported portion is not
        // replaced by the combined local estimate.
        billingComponents: [
            ...(Array.isArray(first.billingComponents) ? first.billingComponents : [first]),
            ...(Array.isArray(second.billingComponents) ? second.billingComponents : [second]),
        ],
    };
}`;

// Minified host bundle. The three closing braces are: cost object, returned
// usage object, function body.
export const MIN_ANCHOR = "total:first.cost.total+second.cost.total}}}";

export const MIN_PATCH =
	"total:first.cost.total+second.cost.total}," +
	`/* ${MARKER} */` +
	"billingComponents:[...(Array.isArray(first.billingComponents)?first.billingComponents:[first])," +
	"...(Array.isArray(second.billingComponents)?second.billingComponents:[second])]}}";

function globalRoots() {
	const roots = new Set();
	try {
		const out = execFileSync("npm", ["root", "-g"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		if (out) roots.add(out);
	} catch {
		// npm unavailable; env override or local-only.
	}
	for (const extra of (process.env.PI_AI_PATCH_ROOTS ?? "").split(":")) {
		if (extra) roots.add(extra);
	}
	return [...roots];
}

function walk(dir, out, depth) {
	if (depth > 8) return;
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			walk(path, out, depth + 1);
		} else if (
			entry.isFile() &&
			entry.name.endsWith(".js") &&
			!entry.name.endsWith(".lazy.js") &&
			(entry.name === "compaction.js" || entry.name.startsWith("chunk-"))
		) {
			out.add(path);
		}
	}
}

function candidates() {
	const roots = [join(ROOT, "node_modules"), ...globalRoots()];
	const found = new Set();
	for (const root of roots) {
		const scoped = join(root, "@earendil-works");
		if (existsSync(scoped)) walk(scoped, found, 0);
	}
	return [...found].sort();
}

function packageVersionFor(file) {
	let dir = dirname(file);
	for (let i = 0; i < 6; i += 1) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest)) {
			try {
				const pkg = JSON.parse(readFileSync(manifest, "utf8"));
				return `${pkg.name}@${pkg.version}`;
			} catch {
				return "unknown";
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return "unknown";
}

/**
 * A file is relevant when it merges usages, or when this patch has already run
 * on it. Staleness is decided by a remaining anchor, not by the marker alone, so
 * a bundle with two `combineUsage` copies where only one was patched is still
 * reported stale.
 */
export function classify(source) {
	if (source.includes(PRETTY_ANCHOR)) {
		return { status: "stale", patch: (s) => s.replaceAll(PRETTY_ANCHOR, PRETTY_PATCH) };
	}
	if (source.includes(MIN_ANCHOR)) {
		return { status: "stale", patch: (s) => s.replaceAll(MIN_ANCHOR, MIN_PATCH) };
	}
	if (source.includes(MARKER)) return { status: "current" };
	return { status: "unsupported" };
}

function isRelevant(source) {
	return source.includes("combineUsage") || source.includes(MARKER);
}

function isRepoLocal(file) {
	return dirname(file).startsWith(join(ROOT, "node_modules"));
}

function apply(file, patch) {
	const before = readFileSync(file, "utf8");
	const after = patch(before);
	if (after === before) throw new Error("replacement produced no change");
	writeFileSync(file, after);
	try {
		execFileSync(process.execPath, ["--check", file], { stdio: ["ignore", "ignore", "pipe"] });
	} catch (error) {
		writeFileSync(file, before);
		throw new Error(`syntax check failed, reverted: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function main() {
	const checkOnly = process.argv.includes("--check");
	const files = candidates();
	const relevant = files.filter((file) => {
		try {
			return isRelevant(readFileSync(file, "utf8"));
		} catch {
			return false;
		}
	});
	if (relevant.length === 0) {
		console.log(`[${MARKER}] no pi-coding-agent combineUsage copies found`);
		process.exit(0);
	}

	let failures = 0;
	let patched = 0;
	for (const file of relevant) {
		const source = readFileSync(file, "utf8");
		const { status, patch } = classify(source);
		const version = packageVersionFor(file);
		const local = isRepoLocal(file) ? "local" : "host";
		if (status === "current") {
			console.log(`[${MARKER}] ${local} ok       ${version} ${file}`);
			continue;
		}
		if (status === "unsupported") {
			console.error(`[${MARKER}] ${local} UNSUPPORTED ${version} ${file}`);
			// A repo-local mismatch blocks postinstall so it cannot silently lose
			// billing; a host copy we cannot confidently rewrite only warns.
			if (local === "local" || checkOnly) failures += 1;
			continue;
		}
		if (checkOnly) {
			console.error(`[${MARKER}] ${local} STALE    ${version} ${file}`);
			failures += 1;
			continue;
		}
		try {
			apply(file, patch);
			patched += 1;
			console.log(`[${MARKER}] ${local} patched  ${version} ${file}`);
		} catch (error) {
			console.error(`[${MARKER}] ${local} FAILED   ${version} ${file}: ${error instanceof Error ? error.message : String(error)}`);
			if (local === "local") failures += 1;
		}
	}

	if (checkOnly) {
		console.log(`[${MARKER}] check: ${relevant.length} copies, ${failures} stale/unsupported`);
		process.exit(failures > 0 ? 1 : 0);
	}
	console.log(`[${MARKER}] apply: ${relevant.length} copies, ${patched} patched, ${failures} failed`);
	process.exit(failures > 0 ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
