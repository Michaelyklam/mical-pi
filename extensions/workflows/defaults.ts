import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  EFFORTS,
  readSubagentDefaults,
  requireConfiguredPiModel,
  type Effort,
  type SubagentDefaults,
} from "../shared/subagent-defaults.ts";

/** A provider selection is a complete explicit route and requires its own model. */
export function resolveWorkflowDefaults(
  opts: { model?: unknown; provider?: unknown; effort?: unknown },
  parentModel: ExtensionContext["model"],
  parentEffort: Effort,
  registry: ExtensionContext["modelRegistry"],
  config: SubagentDefaults = readSubagentDefaults(),
) {
  const defaults = config.harnesses?.pi;
  let model = parentModel;
  if (opts.model !== undefined || opts.provider !== undefined) {
    if (typeof opts.model !== "string" || !opts.model.trim()) {
      throw new Error("`provider` requires `model` as well (a non-empty string)");
    }
    if (opts.provider !== undefined && (typeof opts.provider !== "string" || !opts.provider.trim())) {
      throw new Error("`provider` must be a non-empty string");
    }
    const modelOpt = opts.model;
    const providerOpt = opts.provider as string | undefined;
    let resolved: ExtensionContext["model"];
    if (providerOpt) {
      resolved = registry.find(providerOpt, modelOpt);
    } else {
      const slash = modelOpt.indexOf("/");
      if (slash > 0) {
        resolved = registry.find(modelOpt.slice(0, slash), modelOpt.slice(slash + 1));
      } else {
        // Preserve workflow bare-ID lookup semantics for explicit selections.
        resolved = registry.getAll().find(m => m.id === modelOpt);
      }
    }
    if (!resolved) throw new Error(`unknown model "${providerOpt ? `${providerOpt}/${modelOpt}` : modelOpt}" (use provider/id)`);
    model = resolved;
  } else if (defaults?.model !== undefined) {
    model = requireConfiguredPiModel(registry, defaults.model, parentModel?.provider);
  }
  const effort = opts.effort !== undefined ? opts.effort : defaults?.reasoningEffort ?? parentEffort;
  if (typeof effort !== "string" || !(EFFORTS as readonly string[]).includes(effort)) {
    throw new Error(`invalid effort "${String(effort)}" (use ${EFFORTS.join("|")})`);
  }
  return { model, thinkingLevel: effort as Effort };
}
