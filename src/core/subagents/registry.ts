import type { Persona, RiskLevel } from "../types.js";
import { DEFAULT_SUBAGENT_DEFINITION } from "./default.js";
import {
  DEFAULT_SUBAGENT_NAME,
  type SubagentPersonaConfig,
  type SubagentRuntimeConfig,
  type SubagentToolName,
} from "./types.js";

const INHERITABLE_TOOL_NAMES = new Set<SubagentToolName>([
  "bash",
  "write",
  "edit",
  "web_search",
  "web_fetch",
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
  const toolNames = persona.tools?.map((tool) => tool.name) ?? ["bash", "write", "edit"];
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
}): SubagentEffectiveSettings {
  const model = args.config.model ?? args.persona.model;
  const baseSettings = args.persona.settings ?? {};
  const mergedSettings = args.config.settings
    ? { ...baseSettings, ...args.config.settings }
    : baseSettings;
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

export function getSubagentBasePrompt(
  name: string,
  config?: SubagentPersonaConfig,
): string | undefined {
  if (name === DEFAULT_SUBAGENT_NAME) {
    return DEFAULT_SUBAGENT_DEFINITION.systemPrompt;
  }
  return config?.systemPrompt;
}

export function getSubagentDescription(
  name: string,
  config?: SubagentPersonaConfig,
): string | undefined {
  if (config?.description) return config.description;
  if (name === DEFAULT_SUBAGENT_NAME) {
    return DEFAULT_SUBAGENT_DEFINITION.description;
  }
  return undefined;
}

export function formatSubagentsForPrompt(persona: Persona): string | undefined {
  if (!persona.subagents || Object.keys(persona.subagents).length === 0) {
    return undefined;
  }
  const entries = Object.entries(persona.subagents).filter(([, cfg]) => cfg);
  if (entries.length === 0) return undefined;
  const subagentLines = entries
    .map(([name, cfg]) => {
      const description = getSubagentDescription(name, cfg) ?? "(no description)";
      return `- \`${name}\`: ${description}`;
    })
    .join("\n");
  return `\n\n### Available sub-agents\n\nYou have access to the following sub-agents:\n\n${subagentLines}`;
}
