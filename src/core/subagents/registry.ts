import {
  TOOL_NAME_AGENTS,
  TOOL_NAME_BASH,
  TOOL_NAME_EDIT,
  TOOL_NAME_HISTORY,
  TOOL_NAME_MCP,
  TOOL_NAME_MODELS,
  TOOL_NAME_VIEW_IMAGE,
  TOOL_NAME_WEB,
  TOOL_NAME_WRITE,
} from "../tools/tool_names.js";
import type { Persona } from "../types.js";
import type {
  ClaudeCodeSubagentConfig,
  NativeSubagentConfig,
  SubagentLaunchModel,
  SubagentToolName,
} from "./types.js";

const INHERITABLE_TOOL_NAMES = new Set<SubagentToolName>([
  TOOL_NAME_BASH,
  TOOL_NAME_WRITE,
  TOOL_NAME_EDIT,
  TOOL_NAME_VIEW_IMAGE,
  TOOL_NAME_WEB,
  TOOL_NAME_HISTORY,
  TOOL_NAME_MCP,
  TOOL_NAME_MODELS,
]);

function normalizeTools(tools: SubagentToolName[]): SubagentToolName[] {
  const seen = new Set<SubagentToolName>();
  const normalized: SubagentToolName[] = [];

  for (const tool of tools) {
    if (seen.has(tool)) continue;
    seen.add(tool);
    normalized.push(tool);
  }

  return normalized;
}

function getInheritedSubagentTools(persona: Persona): SubagentToolName[] {
  const toolNames = persona.tools;
  const selected: SubagentToolName[] = [];

  for (const name of toolNames) {
    if (INHERITABLE_TOOL_NAMES.has(name as SubagentToolName)) {
      selected.push(name as SubagentToolName);
    }
  }

  return normalizeTools(selected);
}

type NativeSubagentSettings = Omit<NativeSubagentConfig, "systemPrompt" | "workingDirectory">;
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
  const tools = getInheritedSubagentTools(args.persona);
  if (args.launchModel?.kind === "claude-code") {
    return {
      kind: "claude-code",
      model: args.launchModel.model,
      effort: args.launchModel.reasoning,
      tools,
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
    tools,
  };
}

export function formatSubagentsForPrompt(persona: Persona): string | undefined {
  if (!persona.tools.includes(TOOL_NAME_AGENTS)) {
    return undefined;
  }

  const effective = resolveSubagentEffectiveSettings({ persona });
  const reasoning = effective.settings.reasoning ?? "none";
  const launchModels = persona.subagentLaunchModels;
  const launchModelsText =
    launchModels.length > 0 ? launchModels.map((entry) => `\`${entry}\``).join(", ") : "none";

  return [
    "",
    "",
    "### Subagents",
    "",
    "You can start general-purpose background subagents to work on independent tasks. Start them only when the user or active instructions explicitly request delegation; do not infer authorization from generic task overlap.",
    "",
    'Start and manage subagents with `tau.agents` in the `code` tool, and read its reference with `tau.docs("agents")` first. It can send a subagent queued or steering input, interrupt it, and read selected parts of its conversation. Use the `wait_for_agents` tool when you want to wait for subagents yourself instead of from a program.',
    "",
    `Inherited model: \`${effective.model.provider}/${effective.model.id}:${reasoning}\``,
    `Allowed model overrides: ${launchModelsText}`,
    "",
    "Omit the model override unless the user explicitly requests a specific model.",
  ].join("\n");
}
