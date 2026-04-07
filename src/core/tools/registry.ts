import type { Tool, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import type { Config } from "../config/index.js";
import type { ModelResolver } from "../models/catalog.js";
import type { SubagentControlPlane } from "../subagents/control_plane.js";
import type { SubagentName, SubagentStatus } from "../subagents/types.js";
import type { Persona, RiskLevel } from "../types.js";
import type { TokenCounter } from "../utils/token_counting.js";
import type { BashTruncationInfo } from "./bash.js";

type ToolUiEventWithHeaderTarget = {
  headerTarget: string;
} & (
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
  | { type: "bash_blocked"; toolCallId: string; command: string; reason: string }
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
      message?: string;
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
      message?: string;
    }
  | {
      type: "read_success";
      toolCallId: string;
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
  | { type: "read_blocked"; toolCallId: string; path: string; reason: string }
  | {
      type: "view_image_success";
      toolCallId: string;
      path: string;
      mimeType: string;
      bytes: number;
      uiText: ToolUiText;
    }
  | { type: "view_image_blocked"; toolCallId: string; path: string; reason: string }
  | {
      type: "list_success";
      toolCallId: string;
      path: string;
      offset: number;
      limit: number;
      total: number;
      returned: number;
      entries: string[];
      uiText: ToolUiText;
    }
  | { type: "list_blocked"; toolCallId: string; path: string; reason: string }
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
      output: string;
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
      toolCallId: string;
      path: string;
      bytes: number;
      lines: number;
      content: string;
      uiText: ToolUiText;
    }
  | { type: "write_blocked"; toolCallId: string; path: string; reason: string }
  | {
      type: "edit_success";
      toolCallId: string;
      path: string;
      oldLength: number;
      newLength: number;
      oldText: string;
      newText: string;
      uiText: ToolUiText;
    }
  | { type: "edit_blocked"; toolCallId: string; path: string; reason: string }
);

export type ToolUiEvent =
  | ToolUiEventWithHeaderTarget
  | {
      type: "tool_pruned";
      toolCallId: string;
      content: string;
    };

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
  originHistoryEntryId: string;
  controlPlane: SubagentControlPlane;
};

type ToolDispatchBaseContext = {
  config: Config;
  turnUserHistoryEntryId: string;
  cwd: string;
  toolRegistry: ToolRegistry;
  modelResolver: ModelResolver;
  authPath: string;
  tokenCounter: TokenCounter;
};

export type MainToolDispatchContext = ToolDispatchBaseContext & {
  scope: "main";
  persona: Persona;
  hostCwd: string;
  home: string;
  includeAgentContext: boolean;
  sandboxEnabled: boolean;
  subagentPrompts: Record<string, string>;
  subagentControlPlane: SubagentControlPlane;
};

export type SubagentToolDispatchContext = ToolDispatchBaseContext & {
  scope: "subagent";
  subagentContext: SubagentDispatchContext;
};

export type ToolDispatchContext = MainToolDispatchContext | SubagentToolDispatchContext;

export function isMainToolDispatchContext(
  context: ToolDispatchContext,
): context is MainToolDispatchContext {
  return context.scope === "main";
}

export function isSubagentToolDispatchContext(
  context: ToolDispatchContext,
): context is SubagentToolDispatchContext {
  return context.scope === "subagent";
}

export interface ToolDefinition {
  readonly schema: Tool;
  dispatch(
    toolCall: ToolCall,
    riskLevel: RiskLevel,
    signal: AbortSignal,
    context: ToolDispatchContext,
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
