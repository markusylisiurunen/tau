import type { Tool, ToolCall } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import { z } from "zod";
import type { SubagentResult } from "../subagents/control_plane.js";
import type { RiskLevel } from "../types.js";
import { createToolError, createToolResult } from "../utils/messages.js";
import { parseToolArgs } from "../utils/zod.js";
import {
  isMainToolDispatchContext,
  type ToolDefinition,
  type ToolDispatchContext,
  type ToolDispatchResult,
  type ToolDispatchResultWithPhases,
  type ToolUiEvent,
} from "./registry.js";
import { buildSubagentUiText, formatSubagentStatusLine } from "./subagent_ui.js";
import { TOOL_NAME_TERMINATE_AGENT } from "./tool_names.js";

const TERMINATE_AGENT_DESCRIPTION = [
  "Terminate a running subagent and return its final status.",
  "If the subagent already finished, this returns its latest status snapshot.",
].join(" ");

const TERMINATE_AGENT_ID_DESCRIPTION = "Subagent id to terminate.";

export const TERMINATE_AGENT_TOOL: Tool = {
  name: TOOL_NAME_TERMINATE_AGENT,
  description: TERMINATE_AGENT_DESCRIPTION,
  parameters: Type.Object(
    {
      id: Type.String({ description: TERMINATE_AGENT_ID_DESCRIPTION }),
    },
    { additionalProperties: false },
  ),
};

const terminateArgsSchema = z.object({
  id: z.string().trim().min(1),
});

function formatTerminateResult(result: SubagentResult): string {
  const payload = {
    id: result.id,
    name: result.name,
    title: result.title,
    status: result.status,
    outputs: result.outputs,
    error: result.error,
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

  if (result.status !== "success") {
    const errorLine = result.error ? `Error: ${result.error}` : `Status: ${result.status}`;
    return body ? `${errorLine}\n${body}` : errorLine;
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
      signal: AbortSignal,
      context: ToolDispatchContext,
    ): Promise<ToolDispatchResult | ToolDispatchResultWithPhases> {
      let id = "";
      let headerTarget = "(invalid arguments)";

      const blocked = (reason: string): ToolDispatchResult => {
        const toolResult = createToolError(toolCall, reason);
        const uiEvent: ToolUiEvent = {
          type: "terminate_agent_blocked",
          toolCallId: toolCall.id,
          agentId: id || undefined,
          headerTarget,
          reason,
        };
        return { kind: "single", toolResult, uiEvent };
      };

      const parsedArgs = parseToolArgs(terminateArgsSchema, toolCall.arguments);
      if (!parsedArgs.ok) {
        return blocked(`Invalid arguments: ${parsedArgs.error}`);
      }

      ({ id } = parsedArgs.data);
      headerTarget = id;

      if (!isMainToolDispatchContext(context)) {
        return blocked("The terminate_agent tool is only available in the main session.");
      }

      const controlPlane = context.subagentControlPlane;

      return {
        kind: "phased",
        startedUiEvent: {
          type: "terminate_agent_started",
          toolCallId: toolCall.id,
          agentId: id,
          headerTarget,
        },
        run: (async (): Promise<ToolDispatchResult> => {
          try {
            const result = await controlPlane.terminate(id, signal);
            if (!result) {
              const message = `Unknown subagent ID '${id}'.`;
              const uiText = buildSubagentUiText({
                output: message,
                statusText: "error",
                maxOutputLines: 16,
                fullText: message,
              });
              const uiEvent: ToolUiEvent = {
                type: "terminate_agent_finished",
                toolCallId: toolCall.id,
                agentId: id,
                headerTarget,
                status: "error",
                message,
                uiText,
              };
              const toolResult = createToolError(toolCall, message);
              return { kind: "single", toolResult, uiEvent };
            }

            const resultText = formatTerminateResult(result);
            const succeeded = result.status === "success";
            const baseStatusText = formatSubagentStatusLine({
              costTotal: result.costTotal,
              durationMs: getTerminateDurationMs(result),
            });
            const statusText = succeeded
              ? baseStatusText
              : `${baseStatusText} · Status ${result.status}`;
            const uiText = buildSubagentUiText({
              output: formatTerminateOutput(result),
              statusText,
              maxOutputLines: 16,
              fullText: resultText,
            });
            const uiEvent: ToolUiEvent = {
              type: "terminate_agent_finished",
              toolCallId: toolCall.id,
              agentId: id,
              headerTarget,
              status: succeeded ? "success" : "error",
              finalStatus: result.status,
              message: succeeded ? undefined : `Subagent finished with status ${result.status}.`,
              uiText,
            };
            const toolResult = createToolResult(toolCall, resultText, !succeeded);
            return { kind: "single", toolResult, uiEvent };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const reason = message.trim() || "The terminate_agent request failed.";
            const uiText = buildSubagentUiText({
              output: reason,
              statusText: "error",
              maxOutputLines: 16,
              fullText: reason,
            });
            const uiEvent: ToolUiEvent = {
              type: "terminate_agent_finished",
              toolCallId: toolCall.id,
              agentId: id,
              headerTarget,
              status: "error",
              message: reason,
              uiText,
            };
            const toolResult = createToolError(toolCall, reason);
            return { kind: "single", toolResult, uiEvent };
          }
        })(),
      };
    },
  };
}
