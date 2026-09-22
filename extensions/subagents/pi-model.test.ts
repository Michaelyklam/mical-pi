import assert from "node:assert/strict";
import test from "node:test";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { resolvePiModel } from "./src/backends/pi.ts";

const inherited = { provider: "anthropic", id: "parent-model" };

for (const [hint, provider, id] of [
  [undefined, "anthropic", "parent-model"],
  ["other-model", "anthropic", "other-model"],
  ["openai-codex/gpt-5.4", "openai-codex", "gpt-5.4"],
  ["gateway/vendor/model", "gateway", "vendor/model"],
] as const) {
  test(`resolves ${hint ?? "inherited model"}`, () => {
    const model = { provider, id };
    const registry = { find(actualProvider: string, actualId: string) {
      assert.equal(actualProvider, provider);
      assert.equal(actualId, id);
      return model;
    } } as ModelRegistry;
    assert.equal(resolvePiModel(registry, hint, inherited), model);
  });
}

test("unknown models still fail", () => {
  const registry = { find: () => undefined } as unknown as ModelRegistry;
  assert.throws(() => resolvePiModel(registry, "other/missing", inherited), /Unknown model "missing" for provider "other"/);
});
