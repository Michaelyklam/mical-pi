import assert from "node:assert/strict";
import test from "node:test";
import { createDeferredResultDelivery } from "./src/result-delivery.ts";

test("a result consumed by a later wait is not delivered", () => {
  const delivery = createDeferredResultDelivery<{
    id: string;
    output: string;
  }>();

  delivery.defer({ id: "sa-1", output: "done" });
  delivery.consume(["sa-1"]);

  assert.deepEqual(delivery.drain(), []);
});

test("a delivered result is remembered so a later wait can point at it", () => {
  const delivery = createDeferredResultDelivery<{ id: string }>();

  assert.equal(delivery.wasDelivered("sa-1"), false);
  delivery.markDelivered("sa-1");
  assert.equal(delivery.wasDelivered("sa-1"), true);
  assert.equal(delivery.wasDelivered("sa-2"), false);
});

test("a restart forgets the previous delivery and any buffered retry", () => {
  const delivery = createDeferredResultDelivery<{ id: string }>();

  delivery.defer({ id: "sa-1" });
  delivery.markDelivered("sa-1");
  delivery.forget("sa-1");

  assert.equal(delivery.wasDelivered("sa-1"), false);
  assert.deepEqual(delivery.drain(), []);
});

test("delivery history stays bounded and keeps the most recent ids", () => {
  const delivery = createDeferredResultDelivery<{ id: string }>();

  for (let i = 0; i < 300; i++) delivery.markDelivered(`sa-${i}`);

  assert.equal(delivery.wasDelivered("sa-299"), true);
  assert.equal(delivery.wasDelivered("sa-0"), false);
});

test("clear drops both buffered and delivered state", () => {
  const delivery = createDeferredResultDelivery<{ id: string }>();

  delivery.defer({ id: "sa-1" });
  delivery.markDelivered("sa-2");
  delivery.clear();

  assert.deepEqual(delivery.drain(), []);
  assert.equal(delivery.wasDelivered("sa-2"), false);
});

test("unconsumed results are delivered once in settlement order", () => {
  const delivery = createDeferredResultDelivery<{ id: string }>();
  const first = { id: "sa-1" };
  const second = { id: "sa-2" };

  delivery.defer(first);
  delivery.defer(second);

  assert.deepEqual(delivery.drain(), [first, second]);
  assert.deepEqual(delivery.drain(), []);
});
