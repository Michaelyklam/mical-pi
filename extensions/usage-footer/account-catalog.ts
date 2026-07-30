import { createHash } from "node:crypto";
import type { AccountKey, AccountObservation, DiscoveredAccount, ProviderAccount } from "./domain.ts";

export interface AccountCatalogState {
	version: 1;
	accounts: Record<AccountKey, ProviderAccount>;
	legacyMappings: Record<string, AccountKey>;
}

export interface AccountCatalogStore {
	load(): Promise<AccountCatalogState | undefined>;
	save(state: AccountCatalogState): Promise<void>;
}

const emptyState = (): AccountCatalogState => ({ version: 1, accounts: {}, legacyMappings: {} });
export const hashIdentity = (value: string): string => createHash("sha256").update(value).digest("hex");
const hash = hashIdentity;

export function fingerprintCredential(credential: string): string {
	return hash(credential);
}

function accountKey(providerId: string, identity: string): AccountKey {
	return `${providerId}:${hash(identity).slice(0, 24)}`;
}

export class AccountCatalog {
	private state: AccountCatalogState = emptyState();
	private loaded = false;

	constructor(
		private readonly store: AccountCatalogStore,
		private readonly now: () => number = Date.now,
	) {}

	private async ensureLoaded(): Promise<void> {
		if (this.loaded) return;
		const stored = await this.store.load();
		if (stored?.version === 1) this.state = structuredClone(stored);
		this.loaded = true;
	}

	async load(): Promise<void> {
		await this.ensureLoaded();
	}

	async observe(discovered: DiscoveredAccount): Promise<AccountObservation> {
		await this.ensureLoaded();
		const identity = discovered.stableIdentity
			? `oauth:${discovered.stableIdentity}`
			: `credential:${discovered.credentialFingerprint ?? "unresolved"}`;
		const key = accountKey(discovered.providerId, identity);
		let account = this.state.accounts[key];
		const sameProvider = Object.values(this.state.accounts).filter((item) => item.providerId === discovered.providerId);
		const fingerprint = discovered.credentialFingerprint;
		const matchedByFingerprint = fingerprint
			? sameProvider.find((item) => item.credentialFingerprints.includes(fingerprint))
			: undefined;
		if (matchedByFingerprint) account = matchedByFingerprint;

		const needsRotationDecision =
			discovered.authType === "api_key" && Boolean(fingerprint) && !matchedByFingerprint && sameProvider.some((item) => item.label);
		for (const candidate of sameProvider) candidate.active = false;
		if (!account) {
			const timestamp = this.now();
			account = {
				accountKey: key,
				providerId: discovered.providerId,
				authType: discovered.authType,
				stableIdentityHash: discovered.stableIdentity ? hash(discovered.stableIdentity) : undefined,
				credentialFingerprints: fingerprint ? [fingerprint] : [],
				suggestedLabel: discovered.suggestedLabel,
				archived: false,
				active: true,
				firstSeenAt: timestamp,
				lastSeenAt: timestamp,
			};
			this.state.accounts[key] = account;
		} else {
			account.lastSeenAt = this.now();
			account.active = true;
			if (discovered.suggestedLabel) account.suggestedLabel = discovered.suggestedLabel;
		}
		await this.store.save(this.state);
		return { ...structuredClone(account), needsLabel: !account.label, needsRotationDecision };
	}

	async label(input: { accountKey: AccountKey; label: string }): Promise<void> {
		await this.ensureLoaded();
		const label = input.label.trim();
		if (!label) throw new Error("Account label is required");
		const account = this.state.accounts[input.accountKey];
		if (!account) throw new Error("Unknown Provider Account");
		const duplicate = Object.values(this.state.accounts).find(
			(item) => item.providerId === account.providerId && item.accountKey !== account.accountKey && item.label === label,
		);
		if (duplicate) throw new Error("Account labels must be unique within a provider");
		account.label = label;
		await this.store.save(this.state);
	}

	async attachCredential(key: AccountKey, fingerprint: string): Promise<void> {
		await this.ensureLoaded();
		const account = this.state.accounts[key];
		if (!account) throw new Error("Unknown Provider Account");
		account.active = true;
		account.lastSeenAt = this.now();
		if (!account.credentialFingerprints.includes(fingerprint)) account.credentialFingerprints.push(fingerprint);
		// Remove the provisional account created while waiting for the rotation decision.
		for (const [candidateKey, candidate] of Object.entries(this.state.accounts)) {
			if (candidateKey !== key && candidate.providerId === account.providerId && !candidate.label && candidate.credentialFingerprints.includes(fingerprint)) {
				delete this.state.accounts[candidateKey];
			}
		}
		await this.store.save(this.state);
	}

	async mapLegacyProvider(providerId: string, key: AccountKey): Promise<void> {
		await this.ensureLoaded();
		if (!this.state.accounts[key]) throw new Error("Unknown Provider Account");
		this.state.legacyMappings[providerId] = key;
		await this.store.save(this.state);
	}

	resolve(providerId: string, identity: { stableIdentity?: string; credentialFingerprint?: string }): ProviderAccount | undefined {
		const accounts = Object.values(this.state.accounts).filter((item) => item.providerId === providerId);
		if (identity.stableIdentity) {
			const identityHash = hash(identity.stableIdentity);
			return accounts.find((item) => item.stableIdentityHash === identityHash);
		}
		if (identity.credentialFingerprint) {
			return accounts.find((item) => item.credentialFingerprints.includes(identity.credentialFingerprint!));
		}
		return accounts.find((item) => item.active);
	}

	resolveLegacy(providerId: string): ProviderAccount | undefined {
		const key = this.state.legacyMappings[providerId];
		return key ? this.state.accounts[key] : undefined;
	}

	get(key: AccountKey): ProviderAccount | undefined {
		const account = this.state.accounts[key];
		return account ? structuredClone(account) : undefined;
	}

	list(): ProviderAccount[] {
		return Object.values(this.state.accounts).map((item) => structuredClone(item));
	}

	async activate(key: AccountKey): Promise<void> {
		await this.ensureLoaded();
		const account = this.state.accounts[key];
		if (!account) throw new Error("Unknown Provider Account");
		for (const candidate of Object.values(this.state.accounts)) {
			if (candidate.providerId === account.providerId) candidate.active = candidate.accountKey === key;
		}
		account.lastSeenAt = this.now();
		await this.store.save(this.state);
	}

	async markAllInactive(): Promise<void> {
		await this.ensureLoaded();
		for (const account of Object.values(this.state.accounts)) account.active = false;
		await this.store.save(this.state);
	}

	async archive(key: AccountKey, archived: boolean): Promise<void> {
		await this.ensureLoaded();
		const account = this.state.accounts[key];
		if (!account) throw new Error("Unknown Provider Account");
		account.archived = archived;
		await this.store.save(this.state);
	}
}
