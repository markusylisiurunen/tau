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
