import type { Message, Tool, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import type { Config } from "../config/index.js";
import type { Persona, RiskLevel } from "../types.js";
import type { BashTruncationInfo } from "./bash.js";

const restrictedToolNames = new Set(["read", "grep", "list"]);

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
    }
  | { type: "bash_blocked"; command: string; reason: string; toolCallId?: string }
  | {
      type: "task_started";
      toolCallId: string;
      kind?: "task" | "fork";
      name: string;
      title: string;
    }
  | {
      type: "task_progress";
      toolCallId: string;
      kind?: "task" | "fork";
      name: string;
      title: string;
      event: string;
      costTotal: number;
      turns: number;
      toolCalls: number;
    }
  | {
      type: "task_finished";
      toolCallId: string;
      kind?: "task" | "fork";
      name: string;
      title: string;
      costTotal: number;
      turns: number;
      toolCalls: number;
      status: "success" | "error" | "aborted";
      finalOutput: string;
    }
  | {
      type: "task_blocked";
      toolCallId: string;
      kind?: "task" | "fork";
      name?: string;
      title: string;
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

export type ToolUiText = {
  previewText: string;
  fullText: string;
};

export type ToolDispatchResult = {
  kind: "single";
  toolResult: ToolResultMessage;
  uiEvent?: ToolUiEvent;
};

export type ToolDispatchResultWithPhases = {
  kind: "phased";
  startedUiEvent?: ToolUiEvent;
  uiEvents?: AsyncIterable<ToolUiEvent>;
  run: Promise<ToolDispatchResult>;
};

export type ToolDispatchContext = {
  persona: Persona;
  config: Config;
  history: readonly Message[];
  systemPrompt: string;
  toolRegistry: ToolRegistry;
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

  getEnabledToolSchemas(riskLevel: RiskLevel, personaTools?: Tool[]): Tool[] {
    const baseTools = personaTools ?? this.schemas;
    if (riskLevel === "restricted") {
      return baseTools.filter((tool) => restrictedToolNames.has(tool.name));
    }

    return baseTools.filter((tool) => !restrictedToolNames.has(tool.name));
  }
}
