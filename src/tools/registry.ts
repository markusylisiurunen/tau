import type { Tool, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import type { ToolAccessLevel } from "../types.js";

export type ToolUiEvent =
  | {
      type: "bash_execution";
      command: string;
      exitCode: number | null;
      truncationInfo: import("./bash.js").BashTruncationInfo;
    }
  | { type: "bash_blocked"; command: string; reason: string };

export type ToolDispatchResult = {
  toolResult: ToolResultMessage;
  uiEvent?: ToolUiEvent;
};

export interface ToolDefinition {
  readonly schema: Tool;
  dispatch(toolCall: ToolCall, accessLevel: ToolAccessLevel): Promise<ToolDispatchResult>;
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
