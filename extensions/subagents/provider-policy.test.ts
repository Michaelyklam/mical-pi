import assert from "node:assert/strict";
import test from "node:test";
import {
  piModelProviderViolation,
  providerPolicyViolation,
} from "./src/provider-policy.ts";

test("native harnesses require their exact parent provider billing route", () => {
  assert.equal(providerPolicyViolation("claude", "anthropic"), undefined);
  assert.equal(providerPolicyViolation("codex", "openai-codex"), undefined);
  assert.match(
    providerPolicyViolation("codex", "anthropic") ?? "",
    /different provider billing route/,
  );
  assert.match(
    providerPolicyViolation("claude", "verkada-anthropic") ?? "",
    /different provider billing route/,
  );
});

test("pi stays available but rejects model hints from another provider", () => {
  assert.equal(providerPolicyViolation("pi", "verkada"), undefined);
  assert.equal(piModelProviderViolation("verkada", "verkada"), undefined);
  assert.match(
    piModelProviderViolation("openai-codex", "verkada") ?? "",
    /does not match the parent provider/,
  );
});

test("provider policy fails closed without an active parent model", () => {
  assert.match(providerPolicyViolation("pi", undefined) ?? "", /active parent model/);
  assert.match(
    piModelProviderViolation("anthropic", undefined) ?? "",
    /active parent model/,
  );
});
