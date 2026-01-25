import type { Message, Tool, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import type { Config } from "../config/index.js";
import type { SubagentControlPlane } from "../subagents/control_plane.js";
import type { SubagentName, SubagentStatus } from "../subagents/types.js";
import type { Persona, RiskLevel } from "../types.js";
import type { BashTruncationInfo } from "./bash.js";

export type ToolUiEvent =
  | {
      type: "bash_started";
      toolCallId: string;
      command: string;
    }
  | {
      type: "bash_execution";
      toolCallId: string;
      command: string;
      exitCode: number | null;
      truncationInfo: BashTruncationInfo;
      uiText: ToolUiText;
      durationMs?: number;
      labelOverride?: string;
    }
  | {
      type: "bash_aborted";
      toolCallId: string;
      command: string;
      reason: "aborted" | "interrupted";
    }
  | { type: "bash_blocked"; command: string; reason: string; toolCallId?: string }
  | {
      type: "spawn_agent_started";
      toolCallId: string;
      name: string;
      title: string;
    }
  | {
      type: "spawn_agent_finished";
      toolCallId: string;
      name: string;
      title: string;
      status: "success" | "error";
      agentId?: string;
      message?: string;
      uiText?: ToolUiText;
    }
  | {
      type: "spawn_agent_blocked";
      toolCallId: string;
      name?: string;
      title: string;
      reason: string;
    }
  | {
      type: "send_input_to_agent_started";
      toolCallId: string;
      agentId: string;
      name: string;
      title: string;
    }
  | {
      type: "send_input_to_agent_finished";
      toolCallId: string;
      agentId: string;
      name: string;
      title: string;
      status: "success" | "error";
      message?: string;
      uiText?: ToolUiText;
    }
  | {
      type: "send_input_to_agent_blocked";
      toolCallId: string;
      agentId?: string;
      name?: string;
      title: string;
      reason: string;
    }
  | {
      type: "wait_for_agent_started";
      toolCallId: string;
      agentIds: string[];
    }
  | {
      type: "wait_for_agent_finished";
      toolCallId: string;
      agentIds: string[];
      status: "success" | "error";
      message?: string;
      uiText?: ToolUiText;
    }
  | {
      type: "wait_for_agent_blocked";
      toolCallId: string;
      agentIds?: string[];
      reason: string;
    }
  | {
      type: "terminate_agent_started";
      toolCallId: string;
      agentId: string;
    }
  | {
      type: "terminate_agent_finished";
      toolCallId: string;
      agentId: string;
      status: "success" | "error";
      finalStatus?: SubagentStatus;
      message?: string;
      uiText?: ToolUiText;
    }
  | {
      type: "terminate_agent_blocked";
      toolCallId: string;
      agentId?: string;
      reason: string;
    }
  | {
      type: "web_search_started";
      toolCallId: string;
      objective: string;
    }
  | {
      type: "web_search_finished";
      toolCallId: string;
      objective: string;
      status: "success" | "error";
      costUsd?: number;
    }
  | {
      type: "web_fetch_started";
      toolCallId: string;
      url: string;
    }
  | {
      type: "web_fetch_finished";
      toolCallId: string;
      url: string;
      status: "success" | "error";
      costUsd?: number;
    }
  | {
      type: "read_success";
      path: string;
      startLine: number;
      endLine?: number;
      content: string;
      modelTruncation: {
        truncated: boolean;
        totalLines: number;
        outputLines: number;
      };
      uiText: ToolUiText;
    }
  | { type: "read_blocked"; path: string; reason: string }
  | {
      type: "list_success";
      path: string;
      offset: number;
      limit: number;
      total: number;
      returned: number;
      entries: string[];
      uiText: ToolUiText;
    }
  | { type: "list_blocked"; path: string; reason: string }
  | {
      type: "grep_started";
      toolCallId: string;
      pattern: string;
    }
  | {
      type: "grep_finished";
      toolCallId: string;
      pattern: string;
      status: "success" | "error";
      exitCode: number | null;
      stdout: string;
      stderr: string;
      captureTruncated: boolean;
      uiText: ToolUiText;
    }
  | {
      type: "grep_blocked";
      toolCallId: string;
      pattern: string;
      reason: string;
    }
  | {
      type: "write_success";
      path: string;
      bytes: number;
      lines: number;
      content: string;
      uiText: ToolUiText;
    }
  | { type: "write_blocked"; path: string; reason: string }
  | {
      type: "edit_success";
      path: string;
      oldLength: number;
      newLength: number;
      oldText: string;
      newText: string;
      uiText: ToolUiText;
    }
  | { type: "edit_blocked"; path: string; reason: string };

export type ToolUiLineTone = "diffAdd" | "diffRemove";

export type ToolUiLine = {
  text: string;
  tone?: ToolUiLineTone;
};

export type ToolUiText = {
  previewLines: ToolUiLine[];
  statusLine?: string;
  fullLines: ToolUiLine[];
};

export type ToolDispatchResult = {
  kind: "single";
  toolResult: ToolResultMessage;
  uiEvent?: ToolUiEvent;
};

export type ToolDispatchResultWithPhases = {
  kind: "phased";
  startedUiEvent?: ToolUiEvent;
  run: Promise<ToolDispatchResult>;
};

export type SubagentDispatchContext = {
  id: string;
  name: SubagentName;
  title: string;
  controlPlane: SubagentControlPlane;
};

export type ToolDispatchContext = {
  persona?: Persona;
  config?: Config;
  history?: readonly Message[];
  systemPrompt?: string;
  riskLevel?: RiskLevel;
  subagentPrompts?: Record<string, string>;
  toolRegistry?: ToolRegistry;
  authPath?: string;
  subagentContext?: SubagentDispatchContext;
  subagentControlPlane?: SubagentControlPlane;
};

export interface ToolDefinition {
  readonly schema: Tool;
  dispatch(
    toolCall: ToolCall,
    riskLevel: RiskLevel,
    signal?: AbortSignal,
    context?: ToolDispatchContext,
  ): Promise<ToolDispatchResult | ToolDispatchResultWithPhases>;
}

export class ToolRegistry {
  private readonly byName = new Map<string, ToolDefinition>();

  constructor(definitions: ToolDefinition[]) {
    for (const def of definitions) {
      this.byName.set(def.schema.name, def);
    }
  }

  get schemas(): Tool[] {
    return [...this.byName.values()].map((d) => d.schema);
  }

  get(toolName: string): ToolDefinition | undefined {
    return this.byName.get(toolName);
  }

  getEnabledToolSchemas(personaTools?: Tool[]): Tool[] {
    return personaTools ?? this.schemas;
  }
}
