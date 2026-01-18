import type { ToolCall } from "@mariozechner/pi-ai";

export type ExportToolCall = {
  id: string;
  name: string;
  arguments: ToolCall["arguments"];
};

export type ExportEntry =
  | {
      kind: "user";
      text: string;
      timestamp?: number;
    }
  | {
      kind: "assistant";
      text: string;
      toolCalls: ExportToolCall[];
      timestamp?: number;
    }
  | {
      kind: "tool";
      toolName: string;
      text: string;
      isError: boolean;
      toolCall?: ExportToolCall;
      timestamp?: number;
    };

export type ExportMetadata = {
  title?: string;
  generatedAt?: number;
};
