import type { Tool, ToolCall } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { z } from "zod";
import type { RiskLevel } from "../types.js";
import { createToolError, createToolSuccess } from "../utils/messages.js";
import type { ToolDefinition, ToolDispatchContext, ToolDispatchResult } from "./registry.js";

const COMMUNICATE_DESCRIPTION = [
  "Send a message from a subagent back to the main agent.",
  "The main agent receives these outputs when it waits for subagents to finish.",
].join(" ");

const COMMUNICATE_TEXT_DESCRIPTION = "Text to send to the main agent.";

export const COMMUNICATE_TOOL: Tool = {
  name: "communicate",
  description: COMMUNICATE_DESCRIPTION,
  parameters: Type.Object(
    {
      text: Type.String({ description: COMMUNICATE_TEXT_DESCRIPTION }),
    },
    { additionalProperties: false },
  ),
};

const communicateArgsSchema = z.object({
  text: z.string().catch(""),
});

function parseCommunicateArgs(raw: unknown): { text: string } {
  const parsed = communicateArgsSchema.safeParse(raw);
  return parsed.success ? parsed.data : { text: "" };
}

export function createCommunicateToolDefinition(): ToolDefinition {
  return {
    schema: COMMUNICATE_TOOL,
    async dispatch(
      toolCall: ToolCall,
      _riskLevel: RiskLevel,
      _signal?: AbortSignal,
      context?: ToolDispatchContext,
    ): Promise<ToolDispatchResult> {
      const { text } = parseCommunicateArgs(toolCall.arguments);

      const blocked = (reason: string): ToolDispatchResult => {
        const toolResult = createToolError(toolCall, reason);
        return { kind: "single", toolResult };
      };

      if (!text.trim()) {
        return blocked("missing 'text' parameter. provide a message to send.");
      }

      const subagentContext = context?.subagentContext;
      if (!subagentContext) {
        return blocked("communicate tool is only available to subagents.");
      }

      subagentContext.controlPlane.recordCommunicate(subagentContext.id, text);

      const toolResult = createToolSuccess(toolCall, "communicated");
      return { kind: "single", toolResult };
    },
  };
}
