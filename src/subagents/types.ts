import type { Api, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";

export type SubagentName = "explore" | "web";

export type SubagentPersonaConfig = {
  model: Model<Api>;
  settings?: SimpleStreamOptions;
};

export type SubagentConfigMap = Partial<Record<SubagentName, SubagentPersonaConfig>>;

export type AllowedSubagentToolName = "bash" | "web_search" | "web_fetch";

export type SubagentRiskLevel = "none" | "read-only" | "read-write";

export type SubagentRuntimeDefinition = {
  name: SubagentName;
  description?: string;
  systemPrompt: string;
  allowedTools: AllowedSubagentToolName[];
  riskLevel: SubagentRiskLevel;
  maxSubturns?: number;
};
