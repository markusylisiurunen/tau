import {
  TOOL_NAME_BASH,
  TOOL_NAME_EDIT,
  TOOL_NAME_HISTORY,
  TOOL_NAME_MCP,
  TOOL_NAME_NOOK,
  TOOL_NAME_SPAWN_AGENT,
  TOOL_NAME_VIEW_IMAGE,
  TOOL_NAME_WEB,
  TOOL_NAME_WRITE,
} from "../tools/tool_names.js";
import type { Persona } from "../types.js";
import type { SubagentLaunchModel, SubagentRuntimeConfig, SubagentToolName } from "./types.js";

const INHERITABLE_TOOL_NAMES = new Set<SubagentToolName>([
  TOOL_NAME_BASH,
  TOOL_NAME_WRITE,
  TOOL_NAME_EDIT,
  TOOL_NAME_VIEW_IMAGE,
  TOOL_NAME_WEB,
  TOOL_NAME_HISTORY,
  TOOL_NAME_MCP,
  TOOL_NAME_NOOK,
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

export type SubagentEffectiveSettings = Pick<SubagentRuntimeConfig, "model" | "settings" | "tools">;

export function resolveSubagentEffectiveSettings(args: {
  persona: Persona;
  launchModel?: SubagentLaunchModel;
}): SubagentEffectiveSettings {
  const settings = { ...args.persona.settings };
  if (args.launchModel) {
    settings.reasoning = args.launchModel.reasoning;
  }
  const tools = getInheritedSubagentTools(args.persona);
  return {
    model: args.launchModel?.model ?? args.persona.model,
    settings,
    tools,
  };
}

export function formatSubagentsForPrompt(persona: Persona): string | undefined {
  if (!persona.tools.includes(TOOL_NAME_SPAWN_AGENT)) {
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
    "You can spawn general-purpose background subagents to work on independent tasks. Spawn them only when the user or active instructions explicitly request delegation; do not infer authorization from generic task overlap.",
    "",
    `Inherited model: \`${effective.model.provider}/${effective.model.id}:${reasoning}\``,
    `Allowed model overrides: ${launchModelsText}`,
    "",
    "Omit the model override unless the user explicitly requests a specific model.",
  ].join("\n");
}
