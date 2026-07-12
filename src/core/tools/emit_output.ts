import type { Tool, ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { z } from "zod";
import { createToolError, createToolSuccess } from "../utils/messages.js";
import { formatZodError } from "../utils/zod.js";
import {
  isSubagentToolDispatchContext,
  type ToolDefinition,
  type ToolDispatchContext,
  type ToolDispatchResult,
} from "./registry.js";
import { TOOL_NAME_EMIT_OUTPUT } from "./tool_names.js";

const EMIT_OUTPUT_DESCRIPTION = [
  "Send output from a subagent back to the main agent.",
  "The main agent receives these outputs when it waits for subagents to finish.",
].join(" ");

const EMIT_OUTPUT_TEXT_DESCRIPTION = "Text to send to the main agent.";

export const EMIT_OUTPUT_TOOL: Tool = {
  name: TOOL_NAME_EMIT_OUTPUT,
  description: EMIT_OUTPUT_DESCRIPTION,
  parameters: Type.Object(
    {
      text: Type.String({ description: EMIT_OUTPUT_TEXT_DESCRIPTION }),
    },
    { additionalProperties: false },
  ),
};

const emitOutputArgsSchema = z.object({
  text: z.string().min(1),
});

function parseEmitOutputArgs(
  raw: unknown,
): { ok: true; data: { text: string } } | { ok: false; error: string } {
  const parsed = emitOutputArgsSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: formatZodError(parsed.error) };
  }
  if (!parsed.data.text.trim()) {
    return { ok: false, error: "Text must not be blank." };
  }
  return { ok: true, data: parsed.data };
}

export function createEmitOutputToolDefinition(): ToolDefinition {
  return {
    schema: EMIT_OUTPUT_TOOL,
    async dispatch(
      toolCall: ToolCall,
      _signal: AbortSignal,
      context: ToolDispatchContext,
    ): Promise<ToolDispatchResult> {
      const parsedArgs = parseEmitOutputArgs(toolCall.arguments);

      const blocked = (reason: string): ToolDispatchResult => {
        const toolResult = createToolError(toolCall, reason);
        return { kind: "single", toolResult };
      };

      if (!parsedArgs.ok) {
        return blocked(`Invalid arguments: ${parsedArgs.error}`);
      }

      const { text } = parsedArgs.data;

      if (!isSubagentToolDispatchContext(context)) {
        return blocked("The emit_output tool is only available to subagents.");
      }

      const { subagentContext } = context;

      subagentContext.controlPlane.recordEmitOutput(subagentContext.id, text);

      const toolResult = createToolSuccess(toolCall, "Emitted.");
      return { kind: "single", toolResult };
    },
  };
}
