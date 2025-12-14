import type { Api, Model, SimpleStreamOptions } from "@mariozechner/pi-ai";

export type SubagentName = "explore";

export type SubagentPersonaConfig = {
  model: Model<Api>;
  settings?: SimpleStreamOptions;
};

export type SubagentConfigMap = Partial<Record<SubagentName, SubagentPersonaConfig>>;

export type AllowedSubagentToolName = "bash";

export type SubagentRiskLevel = "none" | "read-only" | "read-write";

export type SubagentRuntimeDefinition = {
  name: SubagentName;
  description?: string;
  systemPrompt: string;
  allowedTools: AllowedSubagentToolName[];
  riskLevel: SubagentRiskLevel;
  maxSubturns?: number;
};
