import type { Tool, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { z } from "zod";
import type { SubagentStateSnapshot } from "../subagents/types.js";
import type { RiskLevel } from "../types.js";
import { createToolError, createToolResult } from "../utils/messages.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import type {
  ToolDefinition,
  ToolDispatchContext,
  ToolDispatchResult,
  ToolDispatchResultWithPhases,
  ToolUiEvent,
} from "./registry.js";
import { buildSubagentUiText } from "./subagent_ui.js";
import { TOOL_NAME_SEND_INPUT_TO_AGENT } from "./tool_names.js";

const SEND_INPUT_TO_AGENT_DESCRIPTION = [
  "Send a follow-up prompt to an existing subagent.",
  "The subagent must be idle before you can send another input.",
].join(" ");

const SEND_INPUT_TO_AGENT_ID_DESCRIPTION = "Subagent id to send input to.";

const SEND_INPUT_TO_AGENT_PROMPT_DESCRIPTION = [
  "The prompt to send to the subagent.",
  "Include all necessary context and instructions for the next run.",
].join(" ");

export const SEND_INPUT_TO_AGENT_TOOL: Tool = {
  name: TOOL_NAME_SEND_INPUT_TO_AGENT,
  description: SEND_INPUT_TO_AGENT_DESCRIPTION,
  parameters: Type.Object(
    {
      id: Type.String({ description: SEND_INPUT_TO_AGENT_ID_DESCRIPTION }),
      prompt: Type.String({ description: SEND_INPUT_TO_AGENT_PROMPT_DESCRIPTION }),
    },
    { additionalProperties: false },
  ),
};

const sendInputArgsSchema = z.object({
  id: z.string().trim().catch(""),
  prompt: z.string().trim().catch(""),
});

function parseSendInputArgs(raw: unknown): { id: string; prompt: string } {
  const parsed = sendInputArgsSchema.safeParse(raw);
  return parsed.success ? parsed.data : { id: "", prompt: "" };
}

function formatSendInputToolResult(args: { id: string; name: string; title: string }): string {
  return [`id: ${args.id}`, `name: ${args.name}`, `title: ${args.title}`, "status: running"].join(
    "\n",
  );
}

function resolveSnapshotTarget(snapshot?: SubagentStateSnapshot, agentId?: string) {
  const name = snapshot?.name ?? "";
  const title = snapshot?.title ?? agentId ?? "(subagent)";
  return { name, title };
}

export function createSendInputToAgentToolDefinition(
  backend: ToolExecutionBackend,
): ToolDefinition {
  return {
    schema: SEND_INPUT_TO_AGENT_TOOL,
    async dispatch(
      toolCall: ToolCall,
      _riskLevel: RiskLevel,
      signal?: AbortSignal,
      context?: ToolDispatchContext,
    ): Promise<ToolDispatchResult | ToolDispatchResultWithPhases> {
      const { id, prompt } = parseSendInputArgs(toolCall.arguments);
      const headerTarget = id || "(subagent)";

      const blocked = (
        reason: string,
        details?: { id?: string; name?: string; title?: string },
      ) => {
        const toolResult = createToolError(toolCall, reason);
        const uiEvent: ToolUiEvent = {
          type: "send_input_to_agent_blocked",
          toolCallId: toolCall.id,
          agentId: details?.id ?? (id || undefined),
          name: details?.name ?? undefined,
          title: details?.title ?? headerTarget,
          headerTarget: details?.title ?? headerTarget,
          reason,
        };
        return { kind: "single", toolResult, uiEvent } satisfies ToolDispatchResult;
      };

      if (!id || !prompt) {
        const missing = [!id ? "id" : undefined, !prompt ? "prompt" : undefined]
          .filter(Boolean)
          .join(", ");
        return blocked(`missing required parameter(s): ${missing}.`, {
          id: id || undefined,
          title: id || "(subagent)",
        });
      }

      const controlPlane = context?.subagentControlPlane;
      if (!controlPlane) {
        return blocked("subagent control plane is not available.", { id });
      }

      const snapshot = controlPlane.getSnapshot(id);
      if (!snapshot) {
        return blocked(`unknown subagent id: ${id}`, { id, title: id });
      }

      const target = resolveSnapshotTarget(snapshot, id);

      return {
        kind: "phased",
        startedUiEvent: {
          type: "send_input_to_agent_started",
          toolCallId: toolCall.id,
          agentId: id,
          name: target.name,
          title: target.title,
          headerTarget: target.title,
        },
        run: (async (): Promise<ToolDispatchResult> => {
          if (signal?.aborted) {
            const toolResult = createToolError(toolCall, "send_input_to_agent aborted");
            const uiEvent: ToolUiEvent = {
              type: "send_input_to_agent_finished",
              toolCallId: toolCall.id,
              agentId: id,
              name: target.name,
              title: target.title,
              headerTarget: target.title,
              status: "error",
              message: "aborted",
            };
            return { kind: "single", toolResult, uiEvent };
          }

          const sendResult = controlPlane.sendInput({
            id,
            prompt,
            config: context?.config ?? {},
            authPath: context?.authPath,
            backend,
            personaId: context?.persona?.id,
          });

          if (!sendResult.ok) {
            const toolResult = createToolError(toolCall, sendResult.reason);
            const uiEvent: ToolUiEvent = {
              type: "send_input_to_agent_blocked",
              toolCallId: toolCall.id,
              agentId: id,
              name: target.name,
              title: target.title,
              headerTarget: target.title,
              reason: sendResult.reason,
            };
            return { kind: "single", toolResult, uiEvent };
          }

          const resultText = formatSendInputToolResult(sendResult);
          const toolResult: ToolResultMessage = createToolResult(toolCall, resultText, false);
          const uiText = buildSubagentUiText({
            output: prompt,
            statusText: `${sendResult.name} · ${sendResult.id}`,
            maxOutputLines: 16,
            fullText: resultText,
          });
          const uiEvent: ToolUiEvent = {
            type: "send_input_to_agent_finished",
            toolCallId: toolCall.id,
            agentId: sendResult.id,
            name: sendResult.name,
            title: sendResult.title,
            headerTarget: sendResult.title,
            status: "success",
            uiText,
          };
          return { kind: "single", toolResult, uiEvent };
        })(),
      };
    },
  };
}
