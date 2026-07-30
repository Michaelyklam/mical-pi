import assert from "node:assert/strict";
import { test } from "node:test";
import { AccountCatalog, type AccountCatalogState } from "./account-catalog.ts";

function memoryStore(initial?: AccountCatalogState) {
	let state = initial;
	return {
		load: async () => state,
		save: async (next: AccountCatalogState) => {
			state = structuredClone(next);
		},
		read: () => state,
	};
}

test("OAuth identity is provider-scoped and a re-login creates another Provider Account", async () => {
	const store = memoryStore();
	const catalog = new AccountCatalog(store);
	const first = await catalog.observe({
		providerId: "anthropic",
		authType: "oauth",
		stableIdentity: "org-1/account-1",
		suggestedLabel: "Verkada Eng",
	});
	await catalog.label({ accountKey: first.accountKey, label: "work" });

	const same = await catalog.observe({
		providerId: "anthropic",
		authType: "oauth",
		stableIdentity: "org-1/account-1",
	});
	const relogin = await catalog.observe({
		providerId: "anthropic",
		authType: "oauth",
		stableIdentity: "org-2/account-2",
	});
	const otherProvider = await catalog.observe({
		providerId: "anthropic-proxy",
		authType: "oauth",
		stableIdentity: "org-1/account-1",
	});

	assert.equal(same.accountKey, first.accountKey);
	assert.notEqual(relogin.accountKey, first.accountKey);
	assert.equal(catalog.get(first.accountKey)?.active, false);
	assert.notEqual(otherProvider.accountKey, first.accountKey);
	assert.equal(catalog.get(first.accountKey)?.label, "work");
});

test("API-key rotation can preserve an existing labeled account", async () => {
	const store = memoryStore();
	const catalog = new AccountCatalog(store);
	const first = await catalog.observe({
		providerId: "verkada",
		authType: "api_key",
		credentialFingerprint: "fingerprint-1",
	});
	await catalog.label({ accountKey: first.accountKey, label: "gateway" });

	const rotated = await catalog.observe({
		providerId: "verkada",
		authType: "api_key",
		credentialFingerprint: "fingerprint-2",
	});
	assert.equal(rotated.needsRotationDecision, true);

	await catalog.attachCredential(first.accountKey, "fingerprint-2");
	const resolved = catalog.resolve("verkada", { credentialFingerprint: "fingerprint-2" });
	assert.equal(resolved?.accountKey, first.accountKey);
	assert.deepEqual(catalog.get(first.accountKey)?.credentialFingerprints.sort(), ["fingerprint-1", "fingerprint-2"]);
});

test("labels are unique within a provider and legacy usage maps to the current account", async () => {
	const store = memoryStore();
	const catalog = new AccountCatalog(store);
	const one = await catalog.observe({ providerId: "openai-codex", authType: "oauth", stableIdentity: "a" });
	const two = await catalog.observe({ providerId: "openai-codex", authType: "oauth", stableIdentity: "b" });
	await catalog.label({ accountKey: one.accountKey, label: "personal" });
	await assert.rejects(() => catalog.label({ accountKey: two.accountKey, label: "personal" }), /unique/i);

	await catalog.mapLegacyProvider("openai-codex", one.accountKey);
	assert.equal(catalog.resolveLegacy("openai-codex")?.accountKey, one.accountKey);
	assert.equal(JSON.stringify(store.read()).includes("sk-"), false);
});
