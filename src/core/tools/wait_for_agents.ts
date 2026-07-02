import type { Tool, ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { z } from "zod";
import type { SubagentResult } from "../subagents/control_plane.js";
import type { RiskLevel } from "../types.js";
import { createToolError, createToolResult } from "../utils/messages.js";
import { truncateForTokens } from "../utils/truncate.js";
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
import { TOOL_NAME_WAIT_FOR_AGENTS } from "./tool_names.js";

const WAIT_FOR_AGENTS_DESCRIPTION = [
  "Wait for one or more subagents and return as soon as at least one requested subagent finishes.",
  "Provide the list of subagent ids returned by spawn_agent.",
].join(" ");

const WAIT_FOR_AGENTS_IDS_DESCRIPTION = "List of subagent ids to wait for.";
const WAIT_FOR_AGENTS_OUTPUT_MAX_TOKENS = 256;

export const WAIT_FOR_AGENTS_TOOL: Tool = {
  name: TOOL_NAME_WAIT_FOR_AGENTS,
  description: WAIT_FOR_AGENTS_DESCRIPTION,
  parameters: Type.Object(
    {
      ids: Type.Array(Type.String({ description: WAIT_FOR_AGENTS_IDS_DESCRIPTION }), {
        minItems: 1,
      }),
    },
    { additionalProperties: false },
  ),
};

const waitArgsSchema = z.object({
  ids: z.array(z.string().trim().min(1)).min(1),
});

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
        ? `Error: ${result.error}`
        : `Status: ${result.status}`
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

function formatWaitOutput(
  results: SubagentResult[],
  requestedIds: string[],
  maxTokensPerSubagent?: number,
): string {
  const output: string[] = [];
  const finishedIds = results.map((result) => result.id);
  const finishedIdSet = new Set(finishedIds);
  const runningIds = requestedIds.filter((id) => !finishedIdSet.has(id));

  if (runningIds.length > 0) {
    output.push(
      `Finished: ${finishedIds.join(", ")}. Still running: ${runningIds.join(", ")}. ` +
        "Call wait_for_agents again with the still-running ids to collect their outputs.",
    );
    output.push("");
  }

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

export function createWaitForAgentsToolDefinition(): ToolDefinition {
  return {
    schema: WAIT_FOR_AGENTS_TOOL,
    async dispatch(
      toolCall: ToolCall,
      _riskLevel: RiskLevel,
      signal: AbortSignal,
      context: ToolDispatchContext,
    ): Promise<ToolDispatchResult | ToolDispatchResultWithPhases> {
      let ids: string[] = [];
      const formatHeaderTarget = (entries: string[]): string => {
        const cleaned = entries.map((id) => id.trim()).filter(Boolean);
        return cleaned.length > 0 ? cleaned.join(", ") : "(invalid arguments)";
      };
      let headerTarget = "(invalid arguments)";

      const blocked = (reason: string): ToolDispatchResult => {
        const toolResult = createToolError(toolCall, reason);
        const uiEvent: ToolUiEvent = {
          type: "wait_for_agents_blocked",
          toolCallId: toolCall.id,
          agentIds: ids,
          headerTarget,
          reason,
        };
        return { kind: "single", toolResult, uiEvent };
      };

      const parsedArgs = parseToolArgs(waitArgsSchema, toolCall.arguments);
      if (!parsedArgs.ok) {
        return blocked(`Invalid arguments: ${parsedArgs.error}`);
      }

      ({ ids } = parsedArgs.data);
      headerTarget = formatHeaderTarget(ids);

      const deduped: string[] = [];
      const seen = new Set<string>();
      for (const id of ids) {
        if (!seen.has(id)) {
          seen.add(id);
          deduped.push(id);
        }
      }
      const dedupedTarget = formatHeaderTarget(deduped);

      if (!isMainToolDispatchContext(context)) {
        return blocked("The wait_for_agents tool is only available in the main session.");
      }

      const controlPlane = context.subagentControlPlane;

      return {
        kind: "phased",
        startedUiEvent: {
          type: "wait_for_agents_started",
          toolCallId: toolCall.id,
          agentIds: deduped,
          headerTarget: dedupedTarget,
        },
        run: (async (): Promise<ToolDispatchResult> => {
          try {
            const results = await controlPlane.waitForAgents(deduped, signal);
            const resultText = formatWaitOutput(results, deduped);
            const outputText = formatWaitOutput(
              results,
              deduped,
              WAIT_FOR_AGENTS_OUTPUT_MAX_TOKENS,
            );
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
              type: "wait_for_agents_finished",
              toolCallId: toolCall.id,
              agentIds: deduped,
              headerTarget: dedupedTarget,
              status: hasFailures ? "error" : "success",
              message: hasFailures ? "One or more subagents reported errors." : undefined,
              uiText,
            };
            const toolResult = createToolResult(toolCall, resultText, hasFailures);
            return { kind: "single", toolResult, uiEvent };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const reason = message.trim() || "The wait_for_agents request failed.";
            const uiText = buildSubagentUiText({
              output: reason,
              statusText: "error",
              fullText: reason,
            });
            const uiEvent: ToolUiEvent = {
              type: "wait_for_agents_finished",
              toolCallId: toolCall.id,
              agentIds: deduped,
              headerTarget: dedupedTarget,
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
