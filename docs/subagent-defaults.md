# Subagent defaults

Background-agent defaults belong in `<agent-dir>/subagents.json`, not in a skill or this repository. The runtime uses Pi's `getAgentDir()`: normally `~/.pi/agent`, or `PI_CODING_AGENT_DIR` when set. There are no project overrides.

The file is optional. Without it, `subagent_spawn` uses Pi and inherits the parent's model and reasoning effort. Explicit Claude Code or Codex spawns use their native defaults. Workflow `agent()` calls inherit the parent Pi model and effort. Installing this package does not require a particular model or provider.

## Configuration

All fields are optional. This example changes only the default effort and leaves model selection portable:

```json
{
  "defaultHarness": "pi",
  "harnesses": {
    "pi": { "reasoningEffort": "medium" },
    "claude": {},
    "codex": {}
  }
}
```

`defaultHarness` accepts `pi`, `claude`, or `codex`. Each entry in `harnesses` accepts:

- `model`: a non-empty, trimmed string. Pi accepts `provider/model-id`, including slashes inside the model ID, or a bare ID resolved within the parent provider. Claude Code and Codex accept their native aliases or slugs.
- `reasoningEffort`: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Each backend maps this scale to its native equivalent.

To choose a Pi route, add `"model": "your-provider/your-model-id"` to `harnesses.pi`. Use an exact ID from your model registry and authenticate that provider first. This file contains preferences, not credentials.

## Precedence and user selections

For `subagent_spawn`, the explicit `harness` wins over `defaultHarness`, otherwise Pi is used. Only the selected harness's defaults apply. Explicit `model` and `reasoning_effort` arguments each win over their configured field. An omitted field still uses config, then Pi parent inheritance or the other CLI's native default.

The parent passes a user's requested model, harness, or effort as explicit arguments. The runtime does not classify prompt text or infer roles to choose a model. A model-only request leaves the configured effort intact; an effort-only request leaves the configured model intact.

Workflow `agent()` always uses Pi defaults, regardless of `defaultHarness`. Its explicit `model` and optional `provider` replace the configured model route; `provider` requires an explicit `model`. An exact `provider/model-id` works without a separate `provider`. Explicit bare model IDs retain workflow's existing catalog lookup behavior. Explicit `effort` overrides only the configured effort.

`/btw` bypasses these background-work defaults and continues to inherit the current parent's Pi model and effort.

## Errors and updates

Only a missing file falls back to portable defaults. Invalid JSON, unknown fields, invalid harness names or efforts, and unreadable files fail the spawn or workflow agent with a config-path error. A configured Pi model must exist in the registry and be available with the current authentication. Unknown or unavailable routes fail clearly; the runtime never silently substitutes another model. Native Claude Code and Codex validate their model hints themselves and report CLI failures through the child result.

Edit your own `subagents.json` to update preferences. The runtime reads it for each spawn or workflow agent call, so config changes need no reload and do not alter running children. Remove a field to restore its fallback, or remove the file to restore all portable defaults. Keep personal model choices outside git. When first upgrading to this runtime implementation, reload the extensions; the Pi lifecycle patch requires a full Pi restart.
