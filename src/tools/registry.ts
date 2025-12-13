import type { Tool, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import type { RiskLevel } from "../types.js";

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
  run: Promise<ToolDispatchResult>;
};

export interface ToolDefinition {
  readonly schema: Tool;
  dispatch(
    toolCall: ToolCall,
    riskLevel: RiskLevel,
    signal?: AbortSignal,
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
