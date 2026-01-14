import type { Api, Model } from "@mariozechner/pi-ai";
import type { PersonaSettings } from "../types.js";

export type SubagentName = "explore" | "web";

export type SubagentPersonaConfig = {
  model: Model<Api>;
  settings?: PersonaSettings;
};

export type SubagentConfigMap = Partial<Record<SubagentName, SubagentPersonaConfig>>;

export type AllowedSubagentToolName = "bash" | "web_search" | "web_fetch";

export type SubagentRiskLevel = "restricted" | "read-only" | "read-write";

export type SubagentRuntimeDefinition = {
  name: SubagentName;
  description?: string;
  systemPrompt: string;
  allowedTools: AllowedSubagentToolName[];
  riskLevel: SubagentRiskLevel;
  maxSubturns?: number;
};
