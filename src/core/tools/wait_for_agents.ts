import type { Tool, ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { z } from "zod";
import type { AgentSupervisor } from "../subagents/agent_supervisor.js";
import { formatSubagentStates } from "../subagents/format.js";
import type { SubagentStateSnapshot } from "../subagents/types.js";
import { truncateForTokens } from "../utils/truncate.js";
import { parseToolArgs } from "../utils/zod.js";
import type { ToolActivity } from "./activity.js";
import {
  type AgentTool,
  createTextToolOutcome,
  executeTool,
  type ToolExecutionContext,
  type ToolExecutionOutcome,
  type ToolImplementationOutcome,
} from "./registry.js";
import { buildSubagentUiText, formatSubagentStatusLine } from "./subagent_ui.js";
import { TOOL_NAME_WAIT_FOR_AGENTS } from "./tool_names.js";

const WAIT_FOR_AGENTS_DESCRIPTION = [
  "Wait for one or more subagents and return their state as soon as at least one requested subagent finishes.",
  "Completed agents include their latest response; running agents include their current state.",
  "Responses are retained and may be read repeatedly by calling this tool again with a completed agent id.",
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

function getWaitDurationMs(states: SubagentStateSnapshot[]): number | undefined {
  if (states.length === 0) return undefined;
  let earliest = Number.POSITIVE_INFINITY;
  let latest = 0;
  for (const state of states) {
    earliest = Math.min(earliest, state.run.startedAt);
    latest = Math.max(latest, state.run.status === "running" ? Date.now() : state.run.finishedAt);
  }
  return Number.isFinite(earliest) ? Math.max(0, latest - earliest) : undefined;
}

function getWaitCostTotal(states: SubagentStateSnapshot[]): number {
  return states.reduce((sum, state) => sum + state.costTotal, 0);
}

function formatAgentIdsDisplayTarget(ids: string[]): string {
  return ids.join(", ");
}

function getWaitForAgentsDisplayTarget(raw: unknown): string {
  const parsedArgs = parseToolArgs(waitArgsSchema, raw);
  return parsedArgs.ok ? formatAgentIdsDisplayTarget(parsedArgs.data.ids) : "(invalid arguments)";
}

export function createWaitForAgentsToolDefinition(supervisor: AgentSupervisor): AgentTool {
  return {
    schema: WAIT_FOR_AGENTS_TOOL,
    describe: (toolCall) => ({ headerTarget: getWaitForAgentsDisplayTarget(toolCall.arguments) }),
    async execute(
      toolCall: ToolCall,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionOutcome> {
      const { signal } = context;
      let ids: string[] = [];
      const headerTarget = getWaitForAgentsDisplayTarget(toolCall.arguments);

      const blocked = (reason: string): ToolImplementationOutcome => {
        const outcome = createTextToolOutcome(reason, "blocked");
        const uiEvent: ToolActivity = {
          type: "wait_for_agents_blocked",
          toolCallId: toolCall.id,
          agentIds: ids,
          headerTarget,
          reason,
        };
        return { content: outcome.content, outcome: outcome.outcome, uiEvent };
      };

      const parsedArgs = parseToolArgs(waitArgsSchema, toolCall.arguments);
      if (!parsedArgs.ok) {
        return executeTool(context, () => blocked(`Invalid arguments: ${parsedArgs.error}`));
      }

      ids = [...new Set(parsedArgs.data.ids)];
      const dedupedTarget = formatAgentIdsDisplayTarget(ids);

      return executeTool(
        context,
        async (): Promise<ToolImplementationOutcome> => {
          try {
            const states = await supervisor.waitForAgents(ids, signal);
            const capacity = supervisor.getCapacity();
            const resultText = formatSubagentStates(states, capacity, { includeResponses: true });
            const outputText = truncateForTokens(resultText, {
              maxTokens: WAIT_FOR_AGENTS_OUTPUT_MAX_TOKENS * states.length,
              strategy: "head",
            }).content.trimEnd();
            const hasFailures = states.some(
              (state) => state.run.status === "failed" || state.run.status === "interrupted",
            );
            const statusText = formatSubagentStatusLine({
              costTotal: getWaitCostTotal(states),
              durationMs: getWaitDurationMs(states),
            });
            const uiText = buildSubagentUiText({
              output: outputText,
              statusText,
              fullText: resultText,
            });
            const uiEvent: ToolActivity = {
              type: "wait_for_agents_finished",
              toolCallId: toolCall.id,
              agentIds: ids,
              headerTarget: dedupedTarget,
              status: hasFailures ? "error" : "success",
              message: hasFailures ? "One or more subagent runs did not succeed." : undefined,
              uiText,
            };
            const outcome = createTextToolOutcome(resultText, hasFailures ? "failed" : "succeeded");
            return { content: outcome.content, outcome: outcome.outcome, uiEvent };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const reason = message.trim() || "The wait_for_agents request failed.";
            const uiText = buildSubagentUiText({
              output: reason,
              statusText: "error",
              fullText: reason,
            });
            const uiEvent: ToolActivity = {
              type: "wait_for_agents_finished",
              toolCallId: toolCall.id,
              agentIds: ids,
              headerTarget: dedupedTarget,
              status: "error",
              message: reason,
              uiText,
            };
            const outcome = createTextToolOutcome(reason, signal.aborted ? "cancelled" : "failed");
            return { content: outcome.content, outcome: outcome.outcome, uiEvent };
          }
        },
        {
          type: "wait_for_agents_started",
          toolCallId: toolCall.id,
          agentIds: ids,
          headerTarget: dedupedTarget,
        },
      );
    },
  };
}
