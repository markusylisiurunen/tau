import type { Persona } from "../types.js";
import type {
  ClaudeCodeSubagentConfig,
  NativeSubagentConfig,
  SubagentLaunchModel,
} from "./types.js";

type NativeSubagentSettings = Omit<
  NativeSubagentConfig,
  "systemPrompt" | "workingDirectory" | "autoCompactThresholdTokens"
>;
export type SubagentEffectiveSettings =
  | NativeSubagentSettings
  | Omit<ClaudeCodeSubagentConfig, "workingDirectory">;

export function resolveSubagentEffectiveSettings(args: {
  persona: Persona;
  launchModel?: undefined;
}): NativeSubagentSettings;
export function resolveSubagentEffectiveSettings(args: {
  persona: Persona;
  launchModel?: SubagentLaunchModel;
}): SubagentEffectiveSettings;

export function resolveSubagentEffectiveSettings(args: {
  persona: Persona;
  launchModel?: SubagentLaunchModel;
}): SubagentEffectiveSettings {
  if (args.launchModel?.kind === "claude-code") {
    return {
      kind: "claude-code",
      model: args.launchModel.model,
      effort: args.launchModel.reasoning,
      relay: args.persona.claudeCodeRelay === true,
    };
  }
  const settings = { ...args.persona.settings };
  if (args.launchModel) {
    settings.reasoning = args.launchModel.reasoning;
  }
  return {
    kind: "native",
    model: args.launchModel?.model ?? args.persona.model,
    settings,
  };
}

export function describeSubagentLaunchChoices(persona: Persona): {
  inherited: string;
  overrides: string[];
} {
  const { model, settings } = resolveSubagentEffectiveSettings({ persona });
  return {
    inherited: `${model.provider}/${model.id}:${settings.reasoning ?? "none"}`,
    overrides: persona.subagentLaunchModels,
  };
}

export function formatSubagentsForPrompt(persona: Persona): string {
  const { inherited, overrides: launchModels } = describeSubagentLaunchChoices(persona);
  const launchModelsText =
    launchModels.length > 0 ? launchModels.map((entry) => `\`${entry}\``).join(", ") : "none";

  return [
    "",
    "",
    "## Subagents",
    "",
    "You can start general-purpose subagents that work on independent tasks in the background. Start them only when the user or active instructions explicitly ask for delegation, because related work alone is no such request.",
    "",
    'Start and manage subagents with `@tau/agents` in the `code` tool, and read its reference with `docs("@tau/agents")` from `@tau/core` first. It can send a subagent queued or steering input, interrupt it, and read selected parts of its conversation. To wait for subagents yourself instead of from a program, use the `wait_for_agents` tool.',
    "",
    `- Inherited model: \`${inherited}\``,
    `- Allowed model overrides: ${launchModelsText}`,
    "",
    "Omit the model override unless the user explicitly asks for a specific model.",
  ].join("\n");
}
