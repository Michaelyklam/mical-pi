import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import { BackendRegistry, type SubagentBackend } from "./src/backend.ts";
import { makeStubBackend } from "./src/backends/stub.ts";
import { SubagentManager, SubagentManagerLive } from "./src/manager.ts";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { spawnConfiguredSubagent } from "./src/spawn.ts";
import type { SpawnTask } from "./src/domain.ts";
import type { SubagentManagerShape } from "./src/manager.ts";
import { resolvePiModel } from "./src/backends/pi.ts";

const model = { provider: "route", id: "configured" };
const registry = { find: () => model, getAvailable: () => [model] } as unknown as ModelRegistry;
const task: SpawnTask = { prompt: "standalone task", title: "worker", cwd: "/tmp", parent: {
  parentCwd: "/tmp", projectTrusted: true, inheritedModel: { provider: "parent", id: "inherited" },
  inheritedThinkingLevel: "high", modelRegistry: registry,
} };

test("spawn entry point uses on-disk config when optional arguments are omitted", () => {
  const dir = mkdtempSync(join(tmpdir(), "spawn-defaults-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  let received: SpawnTask | undefined;
  const manager = { spawn(harness: "pi" | "claude" | "codex", input: SpawnTask) {
    assert.equal(harness, "pi"); received = input; return Effect.succeed({});
  } } as unknown as SubagentManagerShape;
  try {
    process.env.PI_CODING_AGENT_DIR = dir;
    writeFileSync(join(dir, "subagents.json"), JSON.stringify({ defaultHarness: "pi", harnesses: {
      pi: { model: "route/configured", reasoningEffort: "medium" },
    } }));
    spawnConfiguredSubagent(manager, task);
    assert.equal(received?.model, "route/configured");
    assert.equal(received?.reasoningEffort, "medium");
    spawnConfiguredSubagent(manager, { ...task, reasoningEffort: "high" });
    assert.equal(received?.model, "route/configured");
    assert.equal(received?.reasoningEffort, "high");
    spawnConfiguredSubagent(manager, { ...task, model: "parent/explicit" });
    assert.equal(received?.model, "parent/explicit");
    assert.equal(received?.reasoningEffort, "medium");
    writeFileSync(join(dir, "subagents.json"), "{");
    assert.throws(() => spawnConfiguredSubagent(manager, task), /Invalid .*subagents.json/);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("configured unknown model fails before manager spawn; explicit model replaces it", () => {
  let calls = 0;
  const manager = { spawn() { calls++; return Effect.succeed({}); } } as unknown as SubagentManagerShape;
  const badTask = { ...task, parent: { ...task.parent, modelRegistry: { find: () => undefined, getAvailable: () => [] } as unknown as ModelRegistry } };
  const config = { harnesses: { pi: { model: "route/missing" } } };
  assert.throws(() => spawnConfiguredSubagent(manager, badTask, undefined, config), /Unknown configured Pi model/);
  assert.equal(calls, 0);
  spawnConfiguredSubagent(manager, { ...badTask, model: "explicit" }, undefined, config);
  assert.equal(calls, 1);
});

test("exact Pi routes do not require a parent; inheritance and bare IDs do", () => {
  assert.equal(resolvePiModel(registry, "route/configured", undefined), model);
  assert.throws(() => resolvePiModel(registry, undefined, undefined), /active parent model/);
  assert.throws(() => resolvePiModel(registry, "bare", undefined), /active parent model/);
});

test("configured spawn reaches a real manager/backend, while a btw spawn keeps inheritance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spawn-integration-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  let received: SpawnTask | undefined;
  const stub = makeStubBackend({ backend: "pi", defaultModelLabel: "test", contextWindow: 200_000, toolName: "bash", cadenceMs: 1 });
  const backend: SubagentBackend = { ...stub, spawn(input) { received = input; return stub.spawn(input); } };
  const runtime = ManagedRuntime.make(SubagentManagerLive.pipe(Layer.provide(Layer.succeed(BackendRegistry, new Map([["pi", backend]])))));
  try {
    process.env.PI_CODING_AGENT_DIR = dir;
    writeFileSync(join(dir, "subagents.json"), JSON.stringify({ harnesses: { pi: { model: "route/configured", reasoningEffort: "medium" } } }));
    const manager = await runtime.runPromise(SubagentManager);
    const configuredSpawn = spawnConfiguredSubagent(manager, task);
    const child = await runtime.runPromise(configuredSpawn.effect);
    assert.equal(received?.model, "route/configured");
    assert.equal(received?.reasoningEffort, "medium");
    await runtime.runPromise(manager.waitFor([child.id]));
    writeFileSync(join(dir, "subagents.json"), "{"); // /btw does not read background config.
    const btw = await runtime.runPromise(manager.spawn("pi", { ...task, origin: "btw" }));
    assert.equal(received?.origin, "btw");
    assert.equal(received?.model, undefined);
    assert.equal(received?.reasoningEffort, undefined);
    assert.equal(received?.parent.inheritedThinkingLevel, "high");
    assert.deepEqual(received?.parent.inheritedModel, { provider: "parent", id: "inherited" });
    await runtime.runPromise(manager.waitFor([btw.id]));
  } finally {
    await runtime.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tool wiring uses configured spawn but /btw bypasses background defaults", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(source, /harness: Type.Optional\(\s*StringEnum/);
  assert.match(source, /spawnConfiguredSubagent\(\s*manager,/);
  assert.match(source, /manager.spawn\("pi", \{\s*origin: "btw"/);
  const btw = source.slice(source.indexOf('manager.spawn("pi", {'));
  assert.match(btw, /inheritedModel: ctx.model/);
  assert.match(btw, /inheritedThinkingLevel: pi.getThinkingLevel\(\)/);
});
