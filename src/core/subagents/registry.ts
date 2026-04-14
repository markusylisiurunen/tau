import {
  TOOL_NAME_BASH,
  TOOL_NAME_EDIT,
  TOOL_NAME_VIEW_IMAGE,
  TOOL_NAME_WEB_FETCH,
  TOOL_NAME_WEB_SEARCH,
  TOOL_NAME_WRITE,
} from "../tools/tool_names.js";
import type { Persona, RiskLevel } from "../types.js";
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
  TOOL_NAME_WEB_SEARCH,
  TOOL_NAME_WEB_FETCH,
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
  const toolNames = persona.tools?.map((tool) => tool.name) ?? [
    TOOL_NAME_BASH,
    TOOL_NAME_WRITE,
    TOOL_NAME_EDIT,
  ];
  const selected: SubagentToolName[] = [];

  for (const name of toolNames) {
    if (INHERITABLE_TOOL_NAMES.has(name as SubagentToolName)) {
      selected.push(name as SubagentToolName);
    }
  }

  return normalizeTools(selected);
}

export type SubagentEffectiveSettings = Pick<
  SubagentRuntimeConfig,
  "model" | "settings" | "tools" | "riskLevel"
>;

export function resolveSubagentEffectiveSettings(args: {
  persona: Persona;
  config: SubagentPersonaConfig;
  riskLevel: RiskLevel;
  launchModel?: SubagentLaunchModel;
}): SubagentEffectiveSettings {
  const model = args.launchModel?.model ?? args.config.model ?? args.persona.model;
  const baseSettings = args.persona.settings ?? {};
  const mergedSettings = args.config.settings
    ? { ...baseSettings, ...args.config.settings }
    : { ...baseSettings };
  if (args.launchModel) {
    mergedSettings.reasoning = args.launchModel.reasoning;
    delete mergedSettings.serviceTier;
  }
  const tools = args.config.tools
    ? normalizeTools(args.config.tools)
    : getInheritedSubagentTools(args.persona);
  const riskLevel = args.config.riskLevel ?? args.riskLevel;
  return {
    model,
    settings: Object.keys(mergedSettings).length > 0 ? mergedSettings : undefined,
    tools,
    riskLevel,
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
    const launchModels = config.launchModels ?? [];
    const launchModelsText =
      launchModels.length > 0
        ? `\n  - Launch models: ${launchModels.map((entry) => `\`${entry}\``).join(", ")}`
        : "";
    return `- \`${name}\`: ${description}${launchModelsText}`;
  });

  if (subagentLines.length === 0) {
    return undefined;
  }

  return `\n\n### Available sub-agents\n\nYou have access to the following sub-agents:\n\n${subagentLines.join("\n")}`;
}
