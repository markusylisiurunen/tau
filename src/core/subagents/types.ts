import type { Api, Model } from "@earendil-works/pi-ai";
import type { ToolCardLine, ToolCardWrap } from "../tools/presentation.js";
import {
  TOOL_NAME_BASH,
  TOOL_NAME_EDIT,
  TOOL_NAME_HISTORY,
  TOOL_NAME_VIEW_IMAGE,
  TOOL_NAME_WEB,
  TOOL_NAME_WRITE,
} from "../tools/tool_names.js";
import type { PersonaSettings, ReasoningEffort } from "../types.js";

export const DEFAULT_SUBAGENT_NAME = "default";

export type SubagentName = string;

export const SUBAGENT_TOOL_NAMES = [
  TOOL_NAME_BASH,
  TOOL_NAME_WRITE,
  TOOL_NAME_EDIT,
  TOOL_NAME_VIEW_IMAGE,
  TOOL_NAME_WEB,
  TOOL_NAME_HISTORY,
] as const;

export type SubagentToolName = (typeof SUBAGENT_TOOL_NAMES)[number];

export type SubagentLaunchModel = {
  model: Model<Api>;
  reasoning: ReasoningEffort;
  normalized: string;
};

export type SubagentPersonaConfig = {
  systemPrompt?: string;
  description?: string;
  tools?: SubagentToolName[];
  launchModels?: string[];
};

export type SubagentConfigMap = Record<SubagentName, SubagentPersonaConfig>;

export type SubagentUsageSnapshot = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  contextWindowUsageTokens: number;
  contextWindow: number;
};

export type SubagentRunFailure =
  | { kind: "interrupted"; message: string }
  | {
      kind: "auto-compaction-failed" | "model-subturn-limit" | "runtime-error";
      message: string;
    }
  | {
      kind: "provider-error";
      message: string;
      stopReason: string;
    };

type SubagentFailedRunFailure = Exclude<SubagentRunFailure, { kind: "interrupted" }>;
type SubagentInterruptedRunFailure = Extract<SubagentRunFailure, { kind: "interrupted" }>;

type SubagentRunSnapshotBase = {
  revision: number;
  startedAt: number;
  interruptRequested: boolean;
};

export type SubagentRunSnapshot =
  | (SubagentRunSnapshotBase & { status: "running" })
  | (SubagentRunSnapshotBase & {
      status: "succeeded";
      finishedAt: number;
      response: string;
    })
  | (SubagentRunSnapshotBase & {
      status: "failed";
      finishedAt: number;
      failure: SubagentFailedRunFailure;
    })
  | (SubagentRunSnapshotBase & {
      status: "interrupted";
      finishedAt: number;
      failure: SubagentInterruptedRunFailure;
    });

export type SubagentStateSnapshot = {
  id: string;
  name: SubagentName;
  title: string;
  availability: "running" | "idle";
  model: {
    provider: string;
    id: string;
    reasoning: ReasoningEffort;
  };
  workingDirectory: string;
  createdAt: number;
  run: SubagentRunSnapshot;
  costTotal: number;
  usage: SubagentUsageSnapshot;
};

export type SubagentCapacitySnapshot = {
  running: number;
  limit: number;
};

export type SubagentActivity =
  | {
      type: "assistant";
      text: string;
    }
  | {
      type: "tool";
      toolName: string;
      outcome: "succeeded" | "failed" | "blocked" | "cancelled";
      presentation: {
        action: string;
        operation?: string;
        subject: string;
        subjectWrap: ToolCardWrap;
        details: ToolCardLine[];
        metadata: string[];
      };
    }
  | {
      type: "notice";
      severity: "info" | "warn" | "error";
      title: string;
      content?: string[];
    };

export type SubagentEvent =
  | { type: "subagent_spawned"; state: SubagentStateSnapshot }
  | { type: "subagent_run_started"; state: SubagentStateSnapshot }
  | { type: "subagent_updated"; state: SubagentStateSnapshot }
  | {
      type: "subagent_activity";
      state: SubagentStateSnapshot;
      activity: SubagentActivity;
    }
  | { type: "subagent_interrupt_requested"; state: SubagentStateSnapshot }
  | { type: "subagent_finished"; state: SubagentStateSnapshot };

export type SubagentRuntimeConfig = {
  name: SubagentName;
  systemPrompt: string;
  description?: string;
  model: Model<Api>;
  settings: PersonaSettings;
  tools: SubagentToolName[];
  workingDirectory: string;
};
