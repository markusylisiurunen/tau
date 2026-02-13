import type { Api, Model } from "@mariozechner/pi-ai";
import {
  TOOL_NAME_BASH,
  TOOL_NAME_EDIT,
  TOOL_NAME_EMIT_OUTPUT,
  TOOL_NAME_VIEW_IMAGE,
  TOOL_NAME_WEB_FETCH,
  TOOL_NAME_WEB_SEARCH,
  TOOL_NAME_WRITE,
} from "../tools/tool_names.js";
import type { PersonaSettings, ReasoningEffort, RiskLevel } from "../types.js";

export const DEFAULT_SUBAGENT_NAME = "default";

export type SubagentName = string;

export const SUBAGENT_TOOL_NAMES = [
  TOOL_NAME_BASH,
  TOOL_NAME_WRITE,
  TOOL_NAME_EDIT,
  TOOL_NAME_VIEW_IMAGE,
  TOOL_NAME_WEB_SEARCH,
  TOOL_NAME_WEB_FETCH,
  TOOL_NAME_EMIT_OUTPUT,
] as const;

export type SubagentToolName = (typeof SUBAGENT_TOOL_NAMES)[number];

export type SubagentRiskLevel = RiskLevel;

export type SubagentLaunchModel = {
  model: Model<Api>;
  reasoning: ReasoningEffort;
  normalized: string;
};

export type SubagentPersonaConfig = {
  systemPrompt?: string;
  description?: string;
  model?: Model<Api>;
  settings?: PersonaSettings;
  tools?: SubagentToolName[];
  riskLevel?: SubagentRiskLevel;
  launchModels?: string[];
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
  finalText?: string;
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
