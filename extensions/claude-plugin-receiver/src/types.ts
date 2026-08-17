export interface GitSource {
	readonly kind: "git";
	readonly url: string;
	readonly ref?: string;
}

export interface MarketplaceRecord {
	readonly name: string;
	readonly source: GitSource;
	readonly checkoutPath: string;
	readonly currentSha: string;
	readonly lastAttemptAt?: string;
	readonly lastSuccessfulCheckAt?: string;
	readonly lastError?: string;
}

export interface InstalledSkill {
	readonly name: string;
	readonly sourcePath: string;
	readonly cachePath: string;
	readonly digest: string;
}

export interface InstalledVersion {
	readonly version: string;
	readonly sourceSha: string;
	readonly cachePath: string;
	readonly installedAt: string;
	readonly skills: ReadonlyArray<InstalledSkill>;
}

export interface SkillChanges {
	readonly added: ReadonlyArray<string>;
	readonly removed: ReadonlyArray<string>;
	readonly modified: ReadonlyArray<string>;
}

export interface UpdateReceipt extends SkillChanges {
	readonly fromVersion?: string;
	readonly toVersion: string;
	readonly fromSha?: string;
	readonly toSha: string;
	readonly createdAt: string;
}

export interface PluginRecord {
	readonly id: string;
	readonly marketplace: string;
	readonly name: string;
	readonly paused: boolean;
	readonly current?: InstalledVersion;
	readonly previous?: InstalledVersion;
	readonly pendingChangelog?: UpdateReceipt;
	readonly changelogShownVersion?: string;
	readonly changelogClaim?: {
		readonly version: string;
		readonly owner: string;
		readonly claimedAt: string;
	};
	readonly lastAttemptAt?: string;
	readonly lastSuccessfulCheckAt?: string;
	readonly lastUpdateAt?: string;
	readonly lastError?: string;
}

export interface ReceiverState {
	readonly schemaVersion: 1;
	readonly marketplaces: Record<string, MarketplaceRecord>;
	readonly plugins: Record<string, PluginRecord>;
}

export interface MarketplaceManifest {
	readonly name: string;
	readonly owner: { readonly name: string };
	readonly plugins: ReadonlyArray<MarketplacePluginEntry>;
	readonly metadata?: { readonly pluginRoot?: string };
}

export type PluginSource =
	| string
	| {
			readonly source: "github";
			readonly repo: string;
			readonly ref?: string;
			readonly sha?: string;
	  }
	| {
			readonly source: "url";
			readonly url: string;
			readonly ref?: string;
			readonly sha?: string;
	  }
	| {
			readonly source: "git-subdir";
			readonly url: string;
			readonly path: string;
			readonly ref?: string;
			readonly sha?: string;
	  };

export interface MarketplacePluginEntry {
	readonly name: string;
	readonly source: PluginSource;
	readonly version?: string;
	readonly strict?: boolean;
	readonly skills?: string | ReadonlyArray<string>;
	readonly [key: string]: unknown;
}

export interface PluginManifest {
	readonly name: string;
	readonly version?: string;
	readonly skills?: string | ReadonlyArray<string>;
	readonly [key: string]: unknown;
}

export interface LoadedResources {
	readonly skillPaths: ReadonlyArray<string>;
	readonly versions: ReadonlyArray<{ readonly pluginId: string; readonly version: string }>;
}

export interface InstallPreview {
	readonly id: string;
	readonly version: string;
	readonly sourceSha: string;
	readonly marketplaceSha: string;
	readonly selectionDigest: string;
	readonly skills: ReadonlyArray<{ readonly name: string; readonly sourcePath: string }>;
}

export interface SyncResult {
	readonly checked: number;
	readonly updated: ReadonlyArray<PluginRecord>;
	readonly failed: ReadonlyArray<{ readonly id: string; readonly error: string }>;
}
