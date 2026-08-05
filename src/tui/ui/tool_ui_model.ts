import type { ToolRunPresentation } from "../../core/tools/presentation.js";
import type { SessionProtocolToolRun } from "../../protocol/session_protocol.js";

export type ToolUiModel = {
  toolCallId: string;
  status: SessionProtocolToolRun["status"];
  presentation: ToolRunPresentation;
};
