import type { Api, Model } from "@mariozechner/pi-ai";
import type { PersonaSettings, RiskLevel } from "../types.js";

export const DEFAULT_SUBAGENT_NAME = "default";

export type SubagentName = string;

export type SubagentToolName =
  | "bash"
  | "write"
  | "edit"
  | "web_search"
  | "web_fetch"
  | "emit_output";

export type SubagentRiskLevel = RiskLevel;

export type SubagentPersonaConfig = {
  systemPrompt?: string;
  description?: string;
  model?: Model<Api>;
  settings?: PersonaSettings;
  tools?: SubagentToolName[];
  riskLevel?: SubagentRiskLevel;
};

export type SubagentConfigMap = Partial<Record<SubagentName, SubagentPersonaConfig>>;

export type SubagentStatus = "running" | "success" | "error" | "aborted";

export type SubagentStateSnapshot = {
  id: string;
  name: SubagentName;
  title: string;
  status: SubagentStatus;
  costTotal: number;
  turns: number;
  toolCalls: number;
  startedAt: number;
  finishedAt?: number;
  abortRequested?: boolean;
  error?: string;
};

export type SubagentUiEvent =
  | { type: "subagent_spawned"; state: SubagentStateSnapshot }
  | {
      type: "subagent_progress";
      id: string;
      text: string;
      costTotal: number;
      turns: number;
      toolCalls: number;
    }
  | { type: "subagent_emit_output"; id: string; text: string }
  | { type: "subagent_abort_requested"; id: string }
  | { type: "subagent_finished"; state: SubagentStateSnapshot };

export type SubagentDefinition = {
  name: SubagentName;
  description?: string;
  systemPrompt: string;
};

export type SubagentRuntimeConfig = {
  name: SubagentName;
  systemPrompt: string;
  description?: string;
  model: Model<Api>;
  settings?: PersonaSettings;
  tools: SubagentToolName[];
  riskLevel: SubagentRiskLevel;
};
