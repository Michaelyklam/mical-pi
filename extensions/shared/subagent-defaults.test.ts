import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getAgentDir, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { readSubagentDefaults, resolveSubagentDefaults, requireConfiguredPiModel, type SubagentDefaults } from "./subagent-defaults.ts";

const config: SubagentDefaults = { defaultHarness: "claude", harnesses: {
  pi: { model: "route/vendor/model", reasoningEffort: "medium" },
  claude: { model: "native-alias", reasoningEffort: "high" },
  codex: { reasoningEffort: "low" },
} };

test("missing config is portable, per-call reads honor the agent directory and environment", () => {
  const dir = mkdtempSync(join(tmpdir(), "subagent-config-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = dir;
    assert.equal(getAgentDir(), dir);
    assert.deepEqual(readSubagentDefaults(), {});
    assert.deepEqual(resolveSubagentDefaults({}), { harness: "pi", model: undefined, reasoningEffort: undefined, configuredModel: false });
    writeFileSync(join(dir, "subagents.json"), JSON.stringify(config));
    assert.deepEqual(readSubagentDefaults(), config);
    writeFileSync(join(dir, "subagents.json"), "{}");
    assert.deepEqual(readSubagentDefaults(), {});
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const value of ["{", "null", "[]", '{"defaultHarness":"other"}', '{"model":"x"}', '{"harnesses":[]}', '{"harnesses":{"other":{}}}', '{"harnesses":{"pi":null}}', '{"harnesses":{"pi":{"model":" "}}}', '{"harnesses":{"pi":{"reasoningEffort":"urgent"}}}', '{"harnesses":{"pi":{"reasoning_effort":"high"}}}']) {
  test(`invalid config fails with its path: ${value}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-invalid-"));
    try {
      writeFileSync(join(dir, "subagents.json"), value);
      assert.throws(() => readSubagentDefaults(dir), /Invalid .*subagents\.json:/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test("defaults remain isolated by harness and explicit fields override independently", () => {
  assert.equal(resolveSubagentDefaults({}, config).model, "native-alias");
  assert.equal(resolveSubagentDefaults({ harness: "codex" }, config).model, undefined);
  assert.deepEqual(resolveSubagentDefaults({ harness: "pi", model: "explicit" }, config), {
    harness: "pi", model: "explicit", reasoningEffort: "medium", configuredModel: false,
  });
  assert.deepEqual(resolveSubagentDefaults({ harness: "pi", reasoningEffort: "off" }, config), {
    harness: "pi", model: "route/vendor/model", reasoningEffort: "off", configuredModel: true,
  });
});

test("configured Pi routes require exact known, available models, including IDs with slashes", () => {
  const model = { provider: "route", id: "vendor/model" };
  const registry = { find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
    getAvailable: () => [model] } as unknown as ModelRegistry;
  assert.equal(requireConfiguredPiModel(registry, "route/vendor/model"), model);
  assert.throws(() => requireConfiguredPiModel(registry, "vendor/model", "route"), /Unknown configured Pi model/);
  assert.throws(() => requireConfiguredPiModel(registry, "bare"), /requires a provider/);
  assert.throws(() => requireConfiguredPiModel(registry, "route/missing"), /Unknown configured Pi model/);
  assert.throws(() => requireConfiguredPiModel({ find: registry.find, getAvailable: () => [] }, "route/vendor/model"), /unavailable/);
});
