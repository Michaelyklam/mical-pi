import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveWorkflowDefaults } from "./defaults.ts";
import type { SubagentDefaults } from "../shared/subagent-defaults.ts";

const parent = { provider: "parent", id: "inherited" } as ExtensionContext["model"];
const configured = { provider: "route", id: "vendor/configured" } as NonNullable<ExtensionContext["model"]>;
const explicit = { provider: "explicit", id: "selected" } as NonNullable<ExtensionContext["model"]>;
const models = [parent!, configured, explicit];
const registry = { find: (provider: string, id: string) => models.find(m => m.provider === provider && m.id === id),
  getAll: () => models, getAvailable: () => models } as unknown as ExtensionContext["modelRegistry"];
const config: SubagentDefaults = { defaultHarness: "codex", harnesses: {
  pi: { model: "route/vendor/configured", reasoningEffort: "medium" },
  codex: { model: "not-a-pi-model", reasoningEffort: "low" },
} };
const resolve = (opts: Parameters<typeof resolveWorkflowDefaults>[0], defaults = config) => resolveWorkflowDefaults(opts, parent, "high", registry, defaults);

test("no config inherits; workflows use only Pi defaults regardless of default harness", () => {
  assert.deepEqual(resolve({}, {}), { model: parent, thinkingLevel: "high" });
  assert.deepEqual(resolve({}), { model: configured, thinkingLevel: "medium" });
  assert.deepEqual(resolve({}, { defaultHarness: "codex", harnesses: { codex: config.harnesses?.codex } }), { model: parent, thinkingLevel: "high" });
});

test("explicit fields override independently, including off effort and exact route", () => {
  assert.deepEqual(resolve({ effort: "off" }), { model: configured, thinkingLevel: "off" });
  assert.deepEqual(resolve({ model: "selected" }), { model: explicit, thinkingLevel: "medium" });
  assert.deepEqual(resolve({ model: "explicit/selected", effort: "high" }), { model: explicit, thinkingLevel: "high" });
  assert.deepEqual(resolve({ provider: "explicit", model: "selected" }), { model: explicit, thinkingLevel: "medium" });
});

test("partial routes and invalid explicit values fail instead of borrowing configured fields", () => {
  assert.throws(() => resolve({ provider: "explicit" }), /requires `model`/);
  assert.throws(() => resolve({ model: "missing" }), /unknown model/);
  assert.throws(() => resolve({ provider: 42, model: "selected" }), /provider.*non-empty/);
  assert.throws(() => resolve({ effort: "urgent" }), /invalid effort/);
  assert.throws(() => resolve({ effort: null }), /invalid effort/);
});

test("unknown configured model fails; explicit route suppresses only that default", () => {
  const bad: SubagentDefaults = { harnesses: { pi: { model: "bad/missing", reasoningEffort: "medium" } } };
  assert.throws(() => resolve({}, bad), /Unknown configured Pi model/);
  assert.throws(() => resolve({ effort: "high" }, bad), /Unknown configured Pi model/);
  assert.deepEqual(resolve({ model: "explicit/selected" }, bad), { model: explicit, thinkingLevel: "medium" });
});
