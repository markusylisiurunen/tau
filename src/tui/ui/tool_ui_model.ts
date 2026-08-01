import type { ToolActivity } from "../../core/tools/activity.js";
import type { SessionProtocolToolRun } from "../../protocol/session_protocol.js";

export type ToolUiModel = {
  toolCallId: string;
  toolName: string;
  status: SessionProtocolToolRun["status"];
  headerTarget: string;
  code?: string;
  activity?: ToolActivity;
  resultText?: string;
};
