import type { Persona } from "../types.js";
import { EXPLORE_DEFINITION } from "./explore.js";
import type { SubagentName, SubagentRuntimeDefinition } from "./types.js";

export function isSubagentName(value: string): value is SubagentName {
  return value === "explore";
}

export function getSubagentDefinition(name: SubagentName): SubagentRuntimeDefinition {
  switch (name) {
    case "explore":
      return EXPLORE_DEFINITION;
  }
}

export function getSubagentDefinitionFromString(
  name: string,
): SubagentRuntimeDefinition | undefined {
  return isSubagentName(name) ? getSubagentDefinition(name) : undefined;
}

export function formatSubagentsForPrompt(persona: Persona): string | undefined {
  if (!persona.subagents || Object.keys(persona.subagents).length === 0) {
    return undefined;
  }
  const entries = Object.entries(persona.subagents).filter(([, cfg]) => cfg);
  if (entries.length === 0) return undefined;
  const subagentLines = entries
    .map(([name]) => {
      const def = getSubagentDefinitionFromString(name);
      const description = def?.description || "(no description)";
      return `- \`${name}\`: ${description}`;
    })
    .join("\n");
  return `\n\n### Available sub-agents\n\nYou have access to the following sub-agents:\n\n${subagentLines}`;
}
