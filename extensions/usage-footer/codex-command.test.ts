import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveCodexCommand } from "./adapters/codex.ts";

test("Codex executable discovery falls back to user installs when PATH is restricted", () => {
	const home = mkdtempSync(join(tmpdir(), "codex-discovery-test-"));
	try {
		const local = join(home, ".local", "bin", "codex");
		const npm = join(home, ".npm-global", "bin", "codex");
		const pathBin = join(home, "custom-bin");
		for (const path of [local, npm, join(pathBin, "codex")]) {
			mkdirSync(join(path, ".."), { recursive: true });
			writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
		}
		assert.equal(resolveCodexCommand("/nonexistent", home), local);
		assert.equal(resolveCodexCommand(pathBin, home), join(pathBin, "codex"));
		chmodSync(local, 0o600);
		assert.equal(resolveCodexCommand("/nonexistent", home), npm);
		rmSync(npm);
		assert.equal(resolveCodexCommand("/nonexistent", home), "codex");
	} finally { rmSync(home, { recursive: true, force: true }); }
});
