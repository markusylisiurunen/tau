import type { Tool, ToolCall } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { z } from "zod";
import type { SubagentResult } from "../subagents/control_plane.js";
import type { RiskLevel } from "../types.js";
import { createToolError, createToolResult } from "../utils/messages.js";
import { truncateForTokens } from "../utils/truncate.js";
import type {
  ToolDefinition,
  ToolDispatchContext,
  ToolDispatchResult,
  ToolDispatchResultWithPhases,
  ToolUiEvent,
} from "./registry.js";
import { buildSubagentUiText, formatSubagentStatusLine } from "./subagent_ui.js";
import { TOOL_NAME_WAIT_FOR_AGENT } from "./tool_names.js";

const WAIT_FOR_AGENT_DESCRIPTION = [
  "Wait for one or more subagents to finish.",
  "Returns status and outputs for each id from spawn_agent.",
].join(" ");

const WAIT_FOR_AGENT_IDS_DESCRIPTION = "Subagent ids to wait for.";
const WAIT_FOR_AGENT_OUTPUT_MAX_TOKENS = 256;

export const WAIT_FOR_AGENT_TOOL: Tool = {
  name: TOOL_NAME_WAIT_FOR_AGENT,
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

function buildSubagentBody(result: SubagentResult): string {
  const outputs = result.outputs
    .map((text) => text.trimEnd())
    .filter((text) => text.trim().length > 0);
  const finalText = result.finalText?.trimEnd() ?? "";
  const trimmedFinal = finalText.trim();
  if (trimmedFinal && !outputs.some((text) => text.trim() === trimmedFinal)) {
    outputs.push(finalText);
  }

  const errorLine =
    result.status !== "success"
      ? result.error
        ? `error: ${result.error}`
        : `status: ${result.status}`
      : undefined;
  const bodyParts = [errorLine, outputs.join("\n\n")].filter((text) => text?.trim().length);
  return bodyParts.join("\n");
}

function formatSubagentOutputLines(result: SubagentResult): string[] {
  const header = `**${result.id}**`;
  const body = buildSubagentBody(result);
  if (!body.trim()) {
    return [header];
  }
  return [header, ...body.split("\n")];
}

function formatSubagentOutputLinesForUi(result: SubagentResult, maxTokens: number): string[] {
  const header = `**${result.id}**`;
  const body = buildSubagentBody(result);
  if (!body.trim()) {
    return [header];
  }
  const truncated = truncateForTokens(body, { maxTokens, strategy: "head" }).content.trimEnd();
  const bodyLines = truncated ? truncated.split("\n") : [];
  return [header, ...bodyLines];
}

function formatWaitOutput(results: SubagentResult[], maxTokensPerSubagent?: number): string {
  const output: string[] = [];
  results.forEach((result, index) => {
    if (index > 0) output.push("");
    const lines = maxTokensPerSubagent
      ? formatSubagentOutputLinesForUi(result, maxTokensPerSubagent)
      : formatSubagentOutputLines(result);
    output.push(...lines);
  });
  return output.join("\n");
}

function getWaitDurationMs(results: SubagentResult[]): number | undefined {
  if (results.length === 0) return undefined;
  let earliest = Number.POSITIVE_INFINITY;
  let latest = 0;
  for (const result of results) {
    earliest = Math.min(earliest, result.startedAt);
    const finishedAt = result.finishedAt ?? Date.now();
    latest = Math.max(latest, finishedAt);
  }
  if (!Number.isFinite(earliest)) return undefined;
  return Math.max(0, latest - earliest);
}

function getWaitCostTotal(results: SubagentResult[]): number {
  return results.reduce((sum, result) => sum + result.costTotal, 0);
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
      const formatHeaderTarget = (entries: string[]): string => {
        const cleaned = entries.map((id) => id.trim()).filter(Boolean);
        return cleaned.length > 0 ? cleaned.join(", ") : "(no ids)";
      };
      const headerTarget = formatHeaderTarget(ids);

      const blocked = (reason: string): ToolDispatchResult => {
        const toolResult = createToolError(toolCall, reason);
        const uiEvent: ToolUiEvent = {
          type: "wait_for_agent_blocked",
          toolCallId: toolCall.id,
          agentIds: ids.length > 0 ? ids : undefined,
          headerTarget,
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
      const dedupedTarget = formatHeaderTarget(deduped);

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
          headerTarget: dedupedTarget,
        },
        run: (async (): Promise<ToolDispatchResult> => {
          try {
            const results = await controlPlane.waitFor(deduped, signal);
            const resultText = formatWaitOutput(results);
            const outputText = formatWaitOutput(results, WAIT_FOR_AGENT_OUTPUT_MAX_TOKENS);
            const hasFailures = results.some((result) => result.status !== "success");
            const statusText = formatSubagentStatusLine({
              costTotal: getWaitCostTotal(results),
              durationMs: getWaitDurationMs(results),
            });
            const uiText = buildSubagentUiText({
              output: outputText,
              statusText,
              fullText: resultText,
            });
            const uiEvent: ToolUiEvent = {
              type: "wait_for_agent_finished",
              toolCallId: toolCall.id,
              agentIds: deduped,
              headerTarget: dedupedTarget,
              status: hasFailures ? "error" : "success",
              message: hasFailures ? "one or more subagents reported errors" : undefined,
              uiText,
            };
            const toolResult = createToolResult(toolCall, resultText, hasFailures);
            return { kind: "single", toolResult, uiEvent };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const uiEvent: ToolUiEvent = {
              type: "wait_for_agent_finished",
              toolCallId: toolCall.id,
              agentIds: deduped,
              headerTarget: dedupedTarget,
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
