import type { ToolRunPresentation } from "./presentation.js";

type ToolActivityWithPresentation = {
  presentation: ToolRunPresentation;
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
    }
  | {
      type: "tool_call_blocked";
      toolCallId: string;
      toolName: string;
      reason: string;
    }
  | {
      type: "tool_call_started";
      toolCallId: string;
      toolName: string;
    }
  | {
      type: "tool_call_finished";
      toolCallId: string;
      toolName: string;
      status: "success" | "error";
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
    }
  | {
      type: "bash_aborted";
      toolCallId: string;
      command: string;
      reason: "aborted" | "interrupted";
    }
  | { type: "bash_blocked"; toolCallId: string; command: string; reason: string }
  | {
      type: "code_mode_started";
      toolCallId: string;
      toolName: string;
    }
  | {
      type: "code_mode_finished";
      toolCallId: string;
      toolName: string;
      status: "success" | "error";
    }
  | {
      type: "code_mode_blocked";
      toolCallId: string;
      toolName: string;
      reason: string;
    }
  | {
      type: "view_image_success";
      toolCallId: string;
      path: string;
    }
  | { type: "view_image_blocked"; toolCallId: string; path: string; reason: string }
  | {
      type: "write_success";
      toolCallId: string;
      path: string;
    }
  | { type: "write_blocked"; toolCallId: string; path: string; reason: string }
  | {
      type: "edit_success";
      toolCallId: string;
      path: string;
    }
  | { type: "edit_blocked"; toolCallId: string; path: string; reason: string }
);

export type ToolActivity = ToolActivityWithPresentation;
