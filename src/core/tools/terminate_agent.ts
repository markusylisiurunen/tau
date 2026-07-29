import type { Tool, ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { z } from "zod";
import type { SubagentResult } from "../subagents/control_plane.js";
import { createToolError, createToolResult } from "../utils/messages.js";
import { parseToolArgs } from "../utils/zod.js";
import {
  createToolDispatch,
  isMainToolDispatchContext,
  type ToolDefinition,
  type ToolDispatch,
  type ToolDispatchContext,
  type ToolDispatchResult,
  type ToolUiEvent,
} from "./registry.js";
import { buildSubagentUiText, formatSubagentStatusLine } from "./subagent_ui.js";
import { TOOL_NAME_TERMINATE_AGENT } from "./tool_names.js";

const TERMINATE_AGENT_DESCRIPTION = [
  "Terminate a running subagent and return its final status and response.",
  "If the subagent already finished, this returns its latest result.",
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
    finalText: result.finalText,
    error: result.error,
  };

  return JSON.stringify(payload, null, 2);
}

function formatTerminateOutput(result: SubagentResult): string {
  const finalText = result.finalText?.trimEnd() ?? "";
  const body = finalText.trim().length > 0 ? finalText : "";

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

function getTerminateAgentDisplayTarget(raw: unknown): string {
  const parsedArgs = parseToolArgs(terminateArgsSchema, raw);
  return parsedArgs.ok ? parsedArgs.data.id : "(invalid arguments)";
}

export function createTerminateAgentToolDefinition(): ToolDefinition {
  return {
    schema: TERMINATE_AGENT_TOOL,
    getDisplayTarget: (toolCall) => getTerminateAgentDisplayTarget(toolCall.arguments),
    async dispatch(
      toolCall: ToolCall,
      signal: AbortSignal,
      context: ToolDispatchContext,
    ): Promise<ToolDispatch> {
      let id = "";
      const headerTarget = getTerminateAgentDisplayTarget(toolCall.arguments);

      const blocked = (reason: string): ToolDispatchResult => {
        const toolResult = createToolError(toolCall, reason);
        const uiEvent: ToolUiEvent = {
          type: "terminate_agent_blocked",
          toolCallId: toolCall.id,
          agentId: id || undefined,
          headerTarget,
          reason,
        };
        return { toolResult, uiEvent };
      };

      const parsedArgs = parseToolArgs(terminateArgsSchema, toolCall.arguments);
      if (!parsedArgs.ok) {
        return createToolDispatch(() => blocked(`Invalid arguments: ${parsedArgs.error}`));
      }

      ({ id } = parsedArgs.data);

      if (!isMainToolDispatchContext(context)) {
        return createToolDispatch(() =>
          blocked("The terminate_agent tool is only available in the main session."),
        );
      }

      const controlPlane = context.subagentControlPlane;

      return {
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
              return { toolResult, uiEvent };
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
            return { toolResult, uiEvent };
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
            return { toolResult, uiEvent };
          }
        })(),
      };
    },
  };
}
