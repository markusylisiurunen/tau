import {
  TOOL_NAME_BASH,
  TOOL_NAME_EDIT,
  TOOL_NAME_HISTORY,
  TOOL_NAME_VIEW_IMAGE,
  TOOL_NAME_WEB,
  TOOL_NAME_WRITE,
} from "../tools/tool_names.js";
import type { Persona } from "../types.js";
import { buildDefaultSubagentSystemPrompt, DEFAULT_SUBAGENT_DESCRIPTION } from "./default.js";
import {
  DEFAULT_SUBAGENT_NAME,
  type SubagentLaunchModel,
  type SubagentPersonaConfig,
  type SubagentRuntimeConfig,
  type SubagentToolName,
} from "./types.js";

const INHERITABLE_TOOL_NAMES = new Set<SubagentToolName>([
  TOOL_NAME_BASH,
  TOOL_NAME_WRITE,
  TOOL_NAME_EDIT,
  TOOL_NAME_VIEW_IMAGE,
  TOOL_NAME_WEB,
  TOOL_NAME_HISTORY,
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
  const toolNames = persona.tools ?? [TOOL_NAME_BASH, TOOL_NAME_WRITE, TOOL_NAME_EDIT];
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
  config: SubagentPersonaConfig;
  launchModel?: SubagentLaunchModel;
}): SubagentEffectiveSettings {
  const model = args.launchModel?.model ?? args.config.model ?? args.persona.model;
  const baseSettings = args.persona.settings ?? {};
  const mergedSettings = args.config.settings
    ? { ...baseSettings, ...args.config.settings }
    : { ...baseSettings };
  if (args.launchModel) {
    mergedSettings.reasoning = args.launchModel.reasoning;
  }
  const tools = args.config.tools
    ? normalizeTools(args.config.tools)
    : getInheritedSubagentTools(args.persona);
  return {
    model,
    settings: Object.keys(mergedSettings).length > 0 ? mergedSettings : undefined,
    tools,
  };
}

export function getSubagentBasePrompt(args: {
  name: string;
  config: SubagentPersonaConfig;
  mainPersonaSystemPrompt: string;
}): string {
  if (args.name === DEFAULT_SUBAGENT_NAME) {
    return buildDefaultSubagentSystemPrompt(args.mainPersonaSystemPrompt);
  }

  if (!args.config.systemPrompt) {
    throw new Error(`Subagent '${args.name}' is missing a system prompt.`);
  }

  return args.config.systemPrompt;
}

export function getSubagentDescription(
  name: string,
  config: SubagentPersonaConfig,
): string | undefined {
  if (config.description) return config.description;
  if (name === DEFAULT_SUBAGENT_NAME) {
    return DEFAULT_SUBAGENT_DESCRIPTION;
  }
  return undefined;
}

export function formatSubagentsForPrompt(persona: Persona): string | undefined {
  if (!persona.subagents) {
    return undefined;
  }

  const subagentLines = Object.entries(persona.subagents).map(([name, config]) => {
    const description = getSubagentDescription(name, config) ?? "(No description provided.)";
    const effective = resolveSubagentEffectiveSettings({ persona, config });
    const reasoning = effective.settings?.reasoning ?? "none";
    const launchModels = config.launchModels ?? [];
    const launchModelsText =
      launchModels.length > 0
        ? `\n  - Launch model overrides: ${launchModels.map((entry) => `\`${entry}\``).join(", ")}\n    By default, launch the subagent without a model override unless the user explicitly asks to use a specific model.`
        : "";
    return `- \`${name}\`: ${description}\n  - Default runtime: \`${effective.model.provider}/${effective.model.id}:${reasoning}\`${launchModelsText}`;
  });

  if (subagentLines.length === 0) {
    return undefined;
  }

  return [
    "",
    "",
    "### Available sub-agents",
    "",
    "You have access to the following sub-agents:",
    "",
    subagentLines.join("\n"),
    "",
    "Guidelines:",
    "- Trigger: Follow the sub-agent's trigger sensitivity if specified; default is balanced. An exact `@@agent:<name>` reference in the user request, active AGENTS.md instructions, or instructions of an already-active skill explicitly activates that sub-agent. Do not infer sub-agent activation from generic language, keyword, or task overlap.",
  ].join("\n");
}
