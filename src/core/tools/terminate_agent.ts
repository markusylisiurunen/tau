import type { Tool, ToolCall } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { z } from "zod";
import type { SubagentResult } from "../subagents/control_plane.js";
import type { RiskLevel } from "../types.js";
import { createToolError, createToolResult } from "../utils/messages.js";
import type {
  ToolDefinition,
  ToolDispatchContext,
  ToolDispatchResult,
  ToolDispatchResultWithPhases,
  ToolUiEvent,
} from "./registry.js";
import { buildSubagentUiText, formatSubagentStatusLine } from "./subagent_ui.js";

const TERMINATE_AGENT_DESCRIPTION = [
  "Terminate a running subagent and return its final status.",
  "If the subagent already finished, this returns its latest status snapshot.",
].join(" ");

const TERMINATE_AGENT_ID_DESCRIPTION = "Subagent id to terminate.";

export const TERMINATE_AGENT_TOOL: Tool = {
  name: "terminate_agent",
  description: TERMINATE_AGENT_DESCRIPTION,
  parameters: Type.Object(
    {
      id: Type.String({ description: TERMINATE_AGENT_ID_DESCRIPTION }),
    },
    { additionalProperties: false },
  ),
};

const terminateArgsSchema = z.object({
  id: z.string().trim().catch(""),
});

function parseTerminateArgs(raw: unknown): { id: string } {
  const parsed = terminateArgsSchema.safeParse(raw);
  return parsed.success ? parsed.data : { id: "" };
}

function formatTerminateResult(result: SubagentResult): string {
  const payload = {
    id: result.id,
    name: result.name,
    title: result.title,
    status: result.status,
    outputs: result.outputs,
    finalText: result.finalText,
    error: result.error,
    costTotal: result.costTotal,
    turns: result.turns,
    toolCalls: result.toolCalls,
  };

  return JSON.stringify(payload, null, 2);
}

function formatTerminateOutput(result: SubagentResult): string {
  const cleanedOutputs = result.outputs
    .map((text) => text.trimEnd())
    .filter((text) => text.trim().length > 0);
  let body = cleanedOutputs.join("\n\n");
  if (!body) {
    const finalText = result.finalText?.trimEnd() ?? "";
    body = finalText.trim().length > 0 ? finalText : "";
  }

  return body;
}

function getTerminateDurationMs(result: SubagentResult): number | undefined {
  const finishedAt = result.finishedAt ?? Date.now();
  return Math.max(0, finishedAt - result.startedAt);
}

export function createTerminateAgentToolDefinition(): ToolDefinition {
  return {
    schema: TERMINATE_AGENT_TOOL,
    async dispatch(
      toolCall: ToolCall,
      _riskLevel: RiskLevel,
      signal?: AbortSignal,
      context?: ToolDispatchContext,
    ): Promise<ToolDispatchResult | ToolDispatchResultWithPhases> {
      const { id } = parseTerminateArgs(toolCall.arguments);

      const blocked = (reason: string): ToolDispatchResult => {
        const toolResult = createToolError(toolCall, reason);
        const uiEvent: ToolUiEvent = {
          type: "terminate_agent_blocked",
          toolCallId: toolCall.id,
          agentId: id || undefined,
          reason,
        };
        return { kind: "single", toolResult, uiEvent };
      };

      if (!id) {
        return blocked("missing 'id' parameter. provide a subagent id to terminate.");
      }

      const controlPlane = context?.subagentControlPlane;
      if (!controlPlane) {
        return blocked("subagent control plane is not available.");
      }

      return {
        kind: "phased",
        startedUiEvent: {
          type: "terminate_agent_started",
          toolCallId: toolCall.id,
          agentId: id,
        },
        run: (async (): Promise<ToolDispatchResult> => {
          try {
            const result = await controlPlane.terminate(id, signal);
            if (!result) {
              const message = `unknown subagent id '${id}'.`;
              const uiEvent: ToolUiEvent = {
                type: "terminate_agent_finished",
                toolCallId: toolCall.id,
                agentId: id,
                status: "error",
                message,
              };
              const toolResult = createToolError(toolCall, message);
              return { kind: "single", toolResult, uiEvent };
            }

            const resultText = formatTerminateResult(result);
            const statusText = formatSubagentStatusLine({
              costTotal: result.costTotal,
              durationMs: getTerminateDurationMs(result),
            });
            const uiText = buildSubagentUiText({
              output: formatTerminateOutput(result),
              statusText,
              maxOutputLines: 16,
            });
            const uiEvent: ToolUiEvent = {
              type: "terminate_agent_finished",
              toolCallId: toolCall.id,
              agentId: id,
              status: "success",
              finalStatus: result.status,
              message:
                result.status === "success" ? undefined : "subagent did not complete successfully",
              uiText,
            };
            const toolResult = createToolResult(toolCall, resultText, false);
            return { kind: "single", toolResult, uiEvent };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const uiEvent: ToolUiEvent = {
              type: "terminate_agent_finished",
              toolCallId: toolCall.id,
              agentId: id,
              status: "error",
              message,
            };
            const toolResult = createToolError(toolCall, message);
            return { kind: "single", toolResult, uiEvent };
          }
        })(),
      };
    },
  };
}
