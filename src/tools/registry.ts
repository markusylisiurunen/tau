import type { Tool, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import type { Config } from "../config.js";
import type { Persona, RiskLevel } from "../types.js";

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
      truncationInfo: import("./bash.js").BashTruncationInfo;
    }
  | { type: "bash_blocked"; command: string; reason: string; toolCallId?: string }
  | {
      type: "task_started";
      toolCallId: string;
      name: string;
      title: string;
    }
  | {
      type: "task_progress";
      toolCallId: string;
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
      type: "write_success";
      path: string;
      bytes: number;
      lines: number;
      preview: string;
      previewTruncation: {
        truncated: boolean;
        totalLines: number;
        outputLines: number;
      };
    }
  | { type: "write_blocked"; path: string; reason: string }
  | {
      type: "edit_success";
      path: string;
      oldLength: number;
      newLength: number;
      diff: string;
      diffTruncation: {
        truncated: boolean;
        totalLines: number;
        outputLines: number;
      };
    }
  | { type: "edit_blocked"; path: string; reason: string };

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
}
