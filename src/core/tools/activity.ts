import type { SubagentRunSnapshot } from "../subagents/types.js";
import type { BashTruncationInfo } from "./bash.js";

type ToolActivityWithHeaderTarget = {
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
      type: "list_agents_started";
      toolCallId: string;
    }
  | {
      type: "list_agents_finished";
      toolCallId: string;
      status: "success" | "error";
      message?: string;
      uiText?: ToolUiText;
    }
  | {
      type: "list_agents_blocked";
      toolCallId: string;
      reason: string;
    }
  | {
      type: "interrupt_agent_started";
      toolCallId: string;
      agentId: string;
    }
  | {
      type: "interrupt_agent_finished";
      toolCallId: string;
      agentId: string;
      status: "success" | "error";
      finalStatus?: SubagentRunSnapshot["status"];
      message?: string;
      uiText?: ToolUiText;
    }
  | {
      type: "interrupt_agent_blocked";
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

export type ToolActivity = ToolActivityWithHeaderTarget;

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
