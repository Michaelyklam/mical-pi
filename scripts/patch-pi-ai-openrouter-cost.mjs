#!/usr/bin/env node
/**
 * Maintained patch: preserve provider-reported monetary charges in pi-ai.
 *
 * `parseChunkUsage` in `@earendil-works/pi-ai` drops the upstream usage charge
 * that routers such as OpenRouter return and replaces it with a locally
 * calculated estimate:
 *
 *   https://openrouter.ai/docs/cookbook/administration/usage-accounting
 *   - `usage.cost` is "the total amount charged to your account" (USD credits)
 *   - `usage.cost_details.upstream_inference_cost` is the BYOK upstream cost
 *
 * This script rewrites `parseChunkUsage` so the router-reported charge survives
 * on `usage.reportedCost` alongside Pi's estimate (`usage.cost`). Extensions
 * read it through `extensions/shared/billing.ts`; they never infer a reported
 * charge from the generic estimate or from balance deltas.
 *
 * Patches BOTH the repo-local pi-ai copies and the host/global install that
 * actually serves model requests. Idempotent: re-running is a no-op once the
 * marker is present. Remove once fixed upstream in pi-ai.
 *
 * Usage:
 *   node scripts/patch-pi-ai-openrouter-cost.mjs           # apply (idempotent)
 *   node scripts/patch-pi-ai-openrouter-cost.mjs --check   # verify, exit 1 if stale
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MARKER = "PI_REPORTED_COST_PATCH";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Pretty (unbundled dist) and minified (host bundle chunk) anchors. The
// surrounding statement is the last line of `parseChunkUsage`.
export const PRETTY_ANCHOR = "    calculateCost(model, usage);";
export const MIN_ANCHOR = "return calculateCost(model,usage),usage}";

export const PRETTY_PATCH = `    // ${MARKER}: preserve the router-reported charge separately from the local
    // estimate. OpenRouter documents usage.cost as the total amount charged to
    // the account (USD), plus optional BYOK cost_details.upstream_inference_cost.
    // https://openrouter.ai/docs/cookbook/administration/usage-accounting
    const reportedCost = rawUsage.cost;
    if (model.provider === "openrouter" && typeof reportedCost === "number" && Number.isFinite(reportedCost) && reportedCost >= 0) {
        usage.reportedCost = {
            amount: reportedCost,
            currency: "USD",
            source: "openrouter",
        };
        const upstreamCost = rawUsage.cost_details?.upstream_inference_cost;
        if (typeof upstreamCost === "number" && Number.isFinite(upstreamCost)) {
            usage.reportedCost.upstreamInferenceCost = upstreamCost;
        }
    }
`;

export const MIN_PATCH = `/* ${MARKER} */let reportedCost=rawUsage.cost;if(model.provider==="openrouter"&&typeof reportedCost=="number"&&Number.isFinite(reportedCost)&&reportedCost>=0){usage.reportedCost={amount:reportedCost,currency:"USD",source:"openrouter"};let upstreamCost=rawUsage.cost_details?.upstream_inference_cost;typeof upstreamCost=="number"&&Number.isFinite(upstreamCost)&&(usage.reportedCost.upstreamInferenceCost=upstreamCost)}`;

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
			entry.name.includes("openai-completions")
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

export function classify(source) {
	if (source.includes(MARKER)) return { status: "current" };
	if (source.includes(PRETTY_ANCHOR)) {
		return { status: "stale", patch: (s) => s.replace(PRETTY_ANCHOR, PRETTY_PATCH + PRETTY_ANCHOR) };
	}
	if (source.includes(MIN_ANCHOR)) {
		return { status: "stale", patch: (s) => s.replace(MIN_ANCHOR, MIN_PATCH + MIN_ANCHOR) };
	}
	return { status: "unsupported" };
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
if (files.length === 0) {
	console.log(`[${MARKER}] no pi-ai openai-completions copies found`);
	process.exit(0);
}

let failures = 0;
let patched = 0;
for (const file of files) {
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
	console.log(`[${MARKER}] check: ${files.length} copies, ${failures} stale/unsupported`);
	process.exit(failures > 0 ? 1 : 0);
}
console.log(`[${MARKER}] apply: ${files.length} copies, ${patched} patched, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
