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

const WAIT_FOR_AGENT_DESCRIPTION = [
  "Wait for one or more subagents to finish and return their outputs.",
  "Provide the list of subagent ids returned by spawn_agent.",
].join(" ");

const WAIT_FOR_AGENT_IDS_DESCRIPTION = "List of subagent ids to wait for.";

export const WAIT_FOR_AGENT_TOOL: Tool = {
  name: "wait_for_agent",
  description: WAIT_FOR_AGENT_DESCRIPTION,
  parameters: Type.Object(
    {
      ids: Type.Array(Type.String({ description: WAIT_FOR_AGENT_IDS_DESCRIPTION }), {
        minItems: 1,
      }),
    },
    { additionalProperties: false },
  ),
};

const waitArgsSchema = z.object({
  ids: z.array(z.string().trim()).catch([]),
});

function parseWaitArgs(raw: unknown): { ids: string[] } {
  const parsed = waitArgsSchema.safeParse(raw);
  if (!parsed.success) {
    return { ids: [] };
  }

  const ids = parsed.data.ids.map((id) => id.trim()).filter(Boolean);
  return { ids };
}

function formatWaitResult(results: SubagentResult[]): string {
  const payload = {
    subagents: results.map((result) => ({
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
    })),
  };

  return JSON.stringify(payload, null, 2);
}

export function createWaitForAgentToolDefinition(): ToolDefinition {
  return {
    schema: WAIT_FOR_AGENT_TOOL,
    async dispatch(
      toolCall: ToolCall,
      _riskLevel: RiskLevel,
      signal?: AbortSignal,
      context?: ToolDispatchContext,
    ): Promise<ToolDispatchResult | ToolDispatchResultWithPhases> {
      const { ids } = parseWaitArgs(toolCall.arguments);

      const blocked = (reason: string): ToolDispatchResult => {
        const toolResult = createToolError(toolCall, reason);
        const uiEvent: ToolUiEvent = {
          type: "wait_for_agent_blocked",
          toolCallId: toolCall.id,
          agentIds: ids.length > 0 ? ids : undefined,
          reason,
        };
        return { kind: "single", toolResult, uiEvent };
      };

      const deduped: string[] = [];
      const seen = new Set<string>();
      for (const id of ids) {
        if (!seen.has(id)) {
          seen.add(id);
          deduped.push(id);
        }
      }

      if (deduped.length === 0) {
        return blocked("missing 'ids' parameter. provide at least one subagent id.");
      }

      const controlPlane = context?.subagentControlPlane;
      if (!controlPlane) {
        return blocked("subagent control plane is not available.");
      }

      return {
        kind: "phased",
        startedUiEvent: {
          type: "wait_for_agent_started",
          toolCallId: toolCall.id,
          agentIds: deduped,
        },
        run: (async (): Promise<ToolDispatchResult> => {
          try {
            const results = await controlPlane.waitFor(deduped, signal);
            const resultText = formatWaitResult(results);
            const hasFailures = results.some((result) => result.status !== "success");
            const uiEvent: ToolUiEvent = {
              type: "wait_for_agent_finished",
              toolCallId: toolCall.id,
              agentIds: deduped,
              status: hasFailures ? "error" : "success",
              message: hasFailures ? "one or more subagents reported errors" : undefined,
            };
            const toolResult = createToolResult(toolCall, resultText, hasFailures);
            return { kind: "single", toolResult, uiEvent };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const uiEvent: ToolUiEvent = {
              type: "wait_for_agent_finished",
              toolCallId: toolCall.id,
              agentIds: deduped,
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
