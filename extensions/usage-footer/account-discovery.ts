import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fingerprintCredential, hashIdentity } from "./account-catalog.ts";
import { AnthropicUsageAdapter } from "./adapters/anthropic.ts";
import type { DiscoveredAccount, ProviderAccount } from "./domain.ts";

function decodeJwt(token: string): any | undefined {
	try {
		const part = token.split(".")[1];
		if (!part) return undefined;
		return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
	} catch { return undefined; }
}

export function openAIIdentity(token: string): { stableIdentity?: string; suggestedLabel?: string; planType?: string } {
	const claims = decodeJwt(token);
	const auth = claims?.["https://api.openai.com/auth"];
	const profile = claims?.["https://api.openai.com/profile"];
	return {
		stableIdentity: auth?.chatgpt_account_id,
		suggestedLabel: profile?.email ? String(profile.email).split("@")[0] : undefined,
		planType: auth?.chatgpt_plan_type,
	};
}

export class AccountDiscovery {
	constructor(
		private readonly registry: ModelRegistry,
		private readonly anthropic = new AnthropicUsageAdapter(),
	) {}

	providerIds(): string[] {
		return [...new Set(this.registry.getAll().map((model) => String(model.provider)))];
	}

	async discover(providerId: string, signal?: AbortSignal): Promise<DiscoveredAccount | undefined> {
		const model = this.registry.getAll().find((candidate) => candidate.provider === providerId);
		if (!model) return undefined;
		const auth = await this.registry.getProviderAuth(providerId);
		const accessToken = auth?.auth.apiKey;
		if (!accessToken) return undefined;
		if (this.registry.isUsingOAuth(model)) {
			if (providerId === "anthropic") {
				const profile = await this.anthropic.profile(accessToken, signal);
				return { providerId, authType: "oauth", ...profile };
			}
			if (providerId === "openai-codex") {
				const identity = openAIIdentity(accessToken);
				if (identity.stableIdentity) {
					return { providerId, authType: "oauth", stableIdentity: identity.stableIdentity, suggestedLabel: identity.suggestedLabel };
				}
			}
		}
		return {
			providerId,
			authType: "api_key",
			credentialFingerprint: fingerprintCredential(accessToken),
			suggestedLabel: this.registry.getProviderDisplayName(providerId),
		};
	}
}

export async function nativeIdentityMatches(agent: "claude" | "codex", account: ProviderAccount): Promise<boolean> {
	if (!account.stableIdentityHash) return false;
	try {
		if (agent === "claude") {
			const config = JSON.parse(await readFile(join(homedir(), ".claude.json"), "utf8"));
			const oauth = config.oauthAccount;
			const identity = oauth?.organizationUuid ? `${oauth.organizationUuid}/${oauth.accountUuid}` : oauth?.accountUuid;
			return Boolean(identity) && hashIdentity(identity) === account.stableIdentityHash;
		}
		const auth = JSON.parse(await readFile(join(homedir(), ".codex", "auth.json"), "utf8"));
		const token = auth?.tokens?.access_token;
		const identity = token ? openAIIdentity(token).stableIdentity : undefined;
		return Boolean(identity) && hashIdentity(identity!) === account.stableIdentityHash;
	} catch { return false; }
}
