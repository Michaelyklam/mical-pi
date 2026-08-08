import assert from "node:assert/strict";
import { test } from "node:test";
import { RunController } from "./controller.ts";

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

test("RunController reserves calls synchronously and caps global fanout at 16", async () => {
  const controller = new RunController(undefined, 99);
  let active = 0;
  let peak = 0;
  const tasks = Array.from({ length: 32 }, (_, index) =>
    controller.schedule(async () => {
      active++;
      peak = Math.max(peak, active);
      await delay(5);
      active--;
      return index;
    }),
  );
  assert.deepEqual(
    await Promise.all(tasks),
    Array.from({ length: 32 }, (_, i) => i),
  );
  assert.equal(peak, 16);
  assert.equal(await controller.settle(), true);
});

test("RunController propagates invocation cancellation without aborting the run", async () => {
  const controller = new RunController(undefined, 1);
  const invocation = new AbortController();
  const pending = controller.schedule(
    (signal) =>
      new Promise<string>((resolve) => {
        signal.addEventListener("abort", () => resolve("stopped"), {
          once: true,
        });
      }),
    invocation.signal,
  );

  invocation.abort(new Error("Workflow agent request was cancelled"));
  await assert.rejects(pending, /request was cancelled/);
  assert.equal(controller.signal.aborted, false);
  assert.equal(await controller.schedule(async () => "recovered"), "recovered");
  assert.equal(await controller.settle(), true);
});

test("RunController accepts 128 calls and rejects the 129th", async () => {
  const controller = new RunController(undefined, 1);
  for (let index = 0; index < 128; index++) {
    assert.equal(await controller.schedule(async () => index), index);
  }
  await assert.rejects(
    controller.schedule(async () => "too many"),
    /exceeded the limit of 128 agent calls/,
  );
  assert.equal(await controller.settle(), true);
});
