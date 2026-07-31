import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { SubagentStatus } from "../subagents/types.js";
import type { BashTruncationInfo } from "./bash.js";

type ToolUiEventWithHeaderTarget = {
  headerTarget: string;
} & (
  | {
      type: "tool_call_streaming";
      toolCallId: string;
      toolName: string;
    }
  | {
      type: "tool_call_queued";
      toolCallId: string;
      toolName: string;
      code?: string;
    }
  | {
      type: "tool_call_blocked";
      toolCallId: string;
      toolName: string;
      reason: string;
    }
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
      type: "client_tool_finished";
      toolCallId: string;
      toolName: string;
      status: "success" | "error";
      uiText: ToolUiText;
    }
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
      type: "wait_for_agents_started";
      toolCallId: string;
      agentIds: string[];
      headerTarget: string;
    }
  | {
      type: "wait_for_agents_finished";
      toolCallId: string;
      agentIds: string[];
      headerTarget: string;
      status: "success" | "error";
      message?: string;
      uiText?: ToolUiText;
    }
  | {
      type: "wait_for_agents_blocked";
      toolCallId: string;
      agentIds?: string[];
      headerTarget: string;
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
      type: "code_mode_started";
      toolCallId: string;
      toolName: string;
      code: string;
    }
  | {
      type: "code_mode_finished";
      toolCallId: string;
      toolName: string;
      code: string;
      status: "success" | "error";
      uiText: ToolUiText;
    }
  | {
      type: "code_mode_blocked";
      toolCallId: string;
      toolName: string;
      code: string;
      reason: string;
    }
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

export type ToolUiEvent = ToolUiEventWithHeaderTarget;

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

export type ToolExecutionOutcome = {
  content: ToolResultMessage["content"];
  isError: boolean;
};

export type ToolImplementationOutcome = ToolExecutionOutcome & {
  uiEvent?: ToolUiEvent;
};

export function createTextToolOutcome(text: string, isError: boolean): ToolExecutionOutcome {
  return {
    content: [{ type: "text", text }],
    isError,
  };
}

export async function executeTool(
  context: ToolExecutionContext,
  run:
    | ToolImplementationOutcome
    | (() => ToolImplementationOutcome | Promise<ToolImplementationOutcome>),
  startedUiEvent?: ToolUiEvent,
): Promise<ToolExecutionOutcome> {
  if (startedUiEvent) {
    await context.emitActivity(startedUiEvent);
  }
  const result = typeof run === "function" ? await run() : run;
  if (result.uiEvent) {
    await context.emitActivity(result.uiEvent);
  }
  return { content: result.content, isError: result.isError };
}

export type ToolCallDescription = {
  headerTarget: string;
  code?: string;
};

export type ToolActivity = ToolUiEvent;

export type ToolExecutionContext = {
  agentId: string;
  turnId: string;
  assistantMessageId: string;
  signal: AbortSignal;
  emitActivity: (activity: ToolActivity) => Promise<void>;
};

export interface AgentTool {
  readonly schema: Tool;
  describe(toolCall: ToolCall): ToolCallDescription;
  execute(toolCall: ToolCall, context: ToolExecutionContext): Promise<ToolExecutionOutcome>;
}

export class ToolRegistry {
  private readonly byName = new Map<string, AgentTool>();

  constructor(definitions: AgentTool[]) {
    for (const definition of definitions) {
      const name = definition.schema.name;
      if (this.byName.has(name)) {
        throw new Error(`duplicate tool '${name}'`);
      }
      this.byName.set(name, definition);
    }
  }

  get schemas(): Tool[] {
    return [...this.byName.values()].map((definition) => definition.schema);
  }

  get(toolName: string): AgentTool | undefined {
    return this.byName.get(toolName);
  }

  getEnabledTools(toolNames?: string[]): AgentTool[] {
    if (!toolNames) {
      return [...this.byName.values()];
    }

    return toolNames.map((toolName) => {
      const definition = this.byName.get(toolName);
      if (!definition) {
        throw new Error(`tool '${toolName}' is not registered`);
      }
      return definition;
    });
  }

  getEnabledToolSchemas(toolNames?: string[]): Tool[] {
    return this.getEnabledTools(toolNames).map((definition) => definition.schema);
  }
}
