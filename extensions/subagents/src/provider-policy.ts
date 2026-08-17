import type { BackendName } from "./domain.ts";

/**
 * Native harnesses authenticate outside Pi, so each one is tied to one exact
 * Pi billing route. Provider IDs are intentionally not grouped by company:
 * gateways, work accounts, API keys, and subscription routes must remain
 * isolated from one another.
 */
const NATIVE_HARNESS_PROVIDERS = {
  claude: "anthropic",
  codex: "openai-codex",
} as const;

export function providerPolicyViolation(
  backend: BackendName,
  parentProvider: string | undefined,
): string | undefined {
  if (!parentProvider) {
    return "Subagents require an active parent model so its provider billing route can be enforced.";
  }
  if (backend === "pi") return undefined;

  const requiredProvider = NATIVE_HARNESS_PROVIDERS[backend];
  if (parentProvider === requiredProvider) return undefined;
  return `Harness "${backend}" uses provider "${requiredProvider}", but the parent model uses "${parentProvider}". Subagents cannot use a different provider billing route; use the pi harness with the inherited model.`;
}

export function piModelProviderViolation(
  requestedProvider: string,
  parentProvider: string | undefined,
): string | undefined {
  if (!parentProvider) {
    return "Pi subagents require an active parent model so its provider billing route can be enforced.";
  }
  if (requestedProvider === parentProvider) return undefined;
  return `Pi subagent model provider "${requestedProvider}" does not match the parent provider "${parentProvider}". Subagents cannot use a different provider billing route.`;
}
