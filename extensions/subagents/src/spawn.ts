import { resolveSubagentDefaults, requireConfiguredPiModel, type SubagentDefaults } from "../../shared/subagent-defaults.ts";
import type { BackendName, SpawnTask } from "./domain.ts";
import type { SubagentManagerShape } from "./manager.ts";

/** Model-tool entry point only. /btw intentionally calls manager.spawn directly. */
export function spawnConfiguredSubagent(
  manager: Pick<SubagentManagerShape, "spawn">,
  task: SpawnTask,
  harness?: BackendName,
  config?: SubagentDefaults,
) {
  const defaults = resolveSubagentDefaults({ harness, model: task.model, reasoningEffort: task.reasoningEffort }, config);
  if (defaults.harness === "pi" && defaults.configuredModel) {
    if (!task.parent.modelRegistry) throw new Error("Configured Pi model requires a model registry.");
    requireConfiguredPiModel(task.parent.modelRegistry, defaults.model!, task.parent.inheritedModel?.provider);
  }
  return {
    harness: defaults.harness,
    effect: manager.spawn(defaults.harness, { ...task, model: defaults.model, reasoningEffort: defaults.reasoningEffort }),
  };
}
