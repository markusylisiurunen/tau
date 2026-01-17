import type { Api, Model } from "@mariozechner/pi-ai";
import type { PersonaSettings, RiskLevel } from "../types.js";

export type SubagentName = "explore" | "web";

export type SubagentPersonaConfig = {
  model: Model<Api>;
  settings?: PersonaSettings;
};

export type SubagentConfigMap = Partial<Record<SubagentName, SubagentPersonaConfig>>;

export type AllowedSubagentToolName = "bash" | "web_search" | "web_fetch";

export type SubagentRiskLevel = RiskLevel;

export type SubagentRuntimeDefinition = {
  name: SubagentName;
  description?: string;
  systemPrompt: string;
  allowedTools: AllowedSubagentToolName[];
  riskLevel: SubagentRiskLevel;
  maxSubturns?: number;
};
