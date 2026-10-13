import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ModelRegistry } from "@earendil-works/pi-coding-agent";

export const HARNESSES = ["pi", "claude", "codex"] as const;
export type Harness = (typeof HARNESSES)[number];
export const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
export interface HarnessDefaults {
  model?: string;
  reasoningEffort?: Effort;
}
export interface SubagentDefaults {
  defaultHarness?: Harness;
  harnesses?: Partial<Record<Harness, HarnessDefaults>>;
}

function object(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], where: string) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${where}: unknown field "${key}"`);
  }
}

/** Read once per call, without a shared cache. Only a missing file inherits defaults. */
export function readSubagentDefaults(agentDir = getAgentDir()): SubagentDefaults {
  const file = join(agentDir, "subagents.json");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Cannot read ${file}: ${String(error)}`);
  }
  try {
    const config = object(JSON.parse(text), "config");
    keys(config, ["defaultHarness", "harnesses"], "config");
    if (config.defaultHarness !== undefined && !HARNESSES.includes(config.defaultHarness as Harness)) {
      throw new Error(`defaultHarness must be ${HARNESSES.join("|")}`);
    }
    if (config.harnesses !== undefined) {
      const harnesses = object(config.harnesses, "harnesses");
      keys(harnesses, HARNESSES, "harnesses");
      for (const [harness, value] of Object.entries(harnesses)) {
        const defaults = object(value, `harnesses.${harness}`);
        keys(defaults, ["model", "reasoningEffort"], `harnesses.${harness}`);
        if (defaults.model !== undefined && (typeof defaults.model !== "string" || !defaults.model.trim() || defaults.model !== defaults.model.trim())) {
          throw new Error(`harnesses.${harness}.model must be a non-empty, trimmed string`);
        }
        if (defaults.reasoningEffort !== undefined && !EFFORTS.includes(defaults.reasoningEffort as Effort)) {
          throw new Error(`harnesses.${harness}.reasoningEffort must be ${EFFORTS.join("|")}`);
        }
      }
    }
    return config as SubagentDefaults;
  } catch (error) {
    throw new Error(`Invalid ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function resolveSubagentDefaults(
  explicit: HarnessDefaults & { harness?: Harness },
  config = readSubagentDefaults(),
) {
  const harness = explicit.harness ?? config.defaultHarness ?? "pi";
  const defaults = config.harnesses?.[harness];
  return {
    harness,
    model: explicit.model ?? defaults?.model,
    reasoningEffort: explicit.reasoningEffort ?? defaults?.reasoningEffort,
    configuredModel: explicit.model === undefined && defaults?.model !== undefined,
  };
}

/** Configured Pi routes must exist and be usable; never substitute another route. */
export function requireConfiguredPiModel(
  registry: Pick<ModelRegistry, "find" | "getAvailable">,
  hint: string,
  inheritedProvider?: string,
) {
  const slash = hint.indexOf("/");
  const provider = slash > 0 ? hint.slice(0, slash) : inheritedProvider;
  const id = slash > 0 ? hint.slice(slash + 1) : hint;
  if (!provider) throw new Error(`Configured Pi model "${hint}" requires a provider/model-id or an active parent provider.`);
  const model = registry.find(provider, id);
  if (!model) throw new Error(`Unknown configured Pi model "${provider}/${id}" in subagents.json.`);
  if (!registry.getAvailable().some(m => m.provider === provider && m.id === id)) {
    throw new Error(`Configured Pi model "${provider}/${id}" is unavailable (check provider authentication and model availability).`);
  }
  return model;
}
