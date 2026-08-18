import type { Tool, ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { z } from "zod";
import type { AgentSupervisor } from "../subagents/agent_supervisor.js";
import { formatWaitForAgentsResult } from "../subagents/format.js";
import type { SubagentStateSnapshot } from "../subagents/types.js";
import { parseToolArgs } from "../utils/zod.js";
import type { ToolActivity } from "./activity.js";
import { buildToolRunPresentation, type ToolCardLineInput } from "./presentation.js";
import {
  type AgentTool,
  createTextToolOutcome,
  executeTool,
  type ToolExecutionContext,
  type ToolExecutionOutcome,
  type ToolImplementationOutcome,
} from "./registry.js";
import { buildSubagentPresentation, formatSubagentMetadata } from "./subagent_ui.js";
import { TOOL_NAME_WAIT_FOR_AGENTS } from "./tool_names.js";

const WAIT_FOR_AGENTS_DESCRIPTION = [
  "Wait for one or more subagents and return their state as soon as at least one requested subagent finishes.",
  "Completed agents include their latest response; running agents include their current state.",
  "Responses are retained and may be read repeatedly by calling this tool again with a completed agent id.",
].join(" ");

const WAIT_FOR_AGENTS_IDS_DESCRIPTION = "List of single-line subagent ids to wait for.";
const WAIT_FOR_AGENTS_RESPONSE_MAX_LINES = 17;

export const WAIT_FOR_AGENTS_TOOL: Tool = {
  name: TOOL_NAME_WAIT_FOR_AGENTS,
  description: WAIT_FOR_AGENTS_DESCRIPTION,
  parameters: Type.Object(
    {
      ids: Type.Array(
        Type.String({
          description: WAIT_FOR_AGENTS_IDS_DESCRIPTION,
          pattern: "^[^\\r\\n]+$",
        }),
        { minItems: 1 },
      ),
    },
    { additionalProperties: false },
  ),
};

const waitArgsSchema = z
  .object({
    ids: z
      .array(
        z
          .string()
          .trim()
          .min(1, "must not be empty.")
          .refine((id) => !/[\r\n]/.test(id), "must be a single line."),
      )
      .min(1, "must contain at least one subagent ID."),
  })
  .strict();

function getWaitDurationMs(states: SubagentStateSnapshot[]): number | undefined {
  const durations = states.flatMap((state) =>
    state.run.status === "running" ? [] : [Math.max(0, state.run.finishedAt - state.run.startedAt)],
  );
  return durations.length > 0 ? Math.max(...durations) : undefined;
}

function getWaitCostTotal(states: SubagentStateSnapshot[]): number {
  return states.reduce(
    (sum, state) => (state.run.status === "running" ? sum : sum + state.costTotal),
    0,
  );
}

function truncateResponseLines(response: string): string[] {
  const text = response.replace(/\r\n?/g, "\n").trimEnd() || "(empty response)";
  const lines = text.split("\n");
  if (lines.length <= WAIT_FOR_AGENTS_RESPONSE_MAX_LINES) return lines;

  const head = lines.slice(0, 8);
  const tail = lines.slice(-8);
  return [...head, `…${lines.length - 16} more lines…`, ...tail];
}

function buildWaitDetails(states: SubagentStateSnapshot[]): ToolCardLineInput[] {
  return states.flatMap((state): ToolCardLineInput[] => {
    if (state.run.status === "running") return [];

    const details: ToolCardLineInput[] = [
      { text: `${state.id} · ${state.title} · ${state.run.status}` },
    ];
    if (state.run.status === "succeeded") {
      details.push(
        { text: "Response:" },
        ...truncateResponseLines(state.run.response).map((text) => ({ text })),
      );
      return details;
    }

    const stopReason =
      state.run.failure.kind === "provider-error"
        ? ` (stop reason: ${state.run.failure.stopReason})`
        : "";
    details.push({ text: `${state.run.failure.message}${stopReason}` });
    return details;
  });
}

function formatAgentIdsSubject(ids: string[]): string {
  return ids.join(", ");
}

function getWaitForAgentsSubject(raw: unknown): string {
  const parsedArgs = parseToolArgs(waitArgsSchema, raw);
  return parsedArgs.ok ? formatAgentIdsSubject(parsedArgs.data.ids) : "(invalid arguments)";
}

export function createWaitForAgentsToolDefinition(supervisor: AgentSupervisor): AgentTool {
  return {
    schema: WAIT_FOR_AGENTS_TOOL,
    describe: (toolCall) => {
      const subject = getWaitForAgentsSubject(toolCall.arguments);
      return {
        presentation: buildToolRunPresentation({ toolName: TOOL_NAME_WAIT_FOR_AGENTS, subject }),
      };
    },
    async execute(
      toolCall: ToolCall,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionOutcome> {
      const { signal } = context;
      let ids: string[] = [];
      const subject = getWaitForAgentsSubject(toolCall.arguments);

      const blocked = (reason: string): ToolImplementationOutcome => {
        const outcome = createTextToolOutcome(reason, "blocked");
        const uiEvent: ToolActivity = {
          type: "tool_call_blocked",
          toolCallId: toolCall.id,
          toolName: TOOL_NAME_WAIT_FOR_AGENTS,
          presentation: buildToolRunPresentation({
            toolName: TOOL_NAME_WAIT_FOR_AGENTS,
            subject: subject,
            details: [{ text: reason }],
          }),
          reason,
        };
        return { content: outcome.content, outcome: outcome.outcome, uiEvent };
      };

      const parsedArgs = parseToolArgs(waitArgsSchema, toolCall.arguments);
      if (!parsedArgs.ok) {
        return executeTool(context, () => blocked(`Invalid arguments: ${parsedArgs.error}`));
      }

      ids = [...new Set(parsedArgs.data.ids)];
      const dedupedTarget = formatAgentIdsSubject(ids);

      return executeTool(
        context,
        async (): Promise<ToolImplementationOutcome> => {
          try {
            const states = await supervisor.waitForAgents(ids, signal);
            const capacity = supervisor.getCapacity();
            const resultText = formatWaitForAgentsResult(states, capacity);
            const presentation = buildToolRunPresentation({
              toolName: TOOL_NAME_WAIT_FOR_AGENTS,
              subject: dedupedTarget,
              details: buildWaitDetails(states),
              detailTruncation: false,
              metadata: formatSubagentMetadata({
                costTotal: getWaitCostTotal(states),
                durationMs: getWaitDurationMs(states),
              }),
            });
            const uiEvent: ToolActivity = {
              type: "tool_call_finished",
              toolCallId: toolCall.id,
              toolName: TOOL_NAME_WAIT_FOR_AGENTS,
              presentation,
              status: "success",
            };
            const outcome = createTextToolOutcome(resultText, "succeeded");
            return { content: outcome.content, outcome: outcome.outcome, uiEvent };
          } catch (error) {
            const errorMessage = (error instanceof Error ? error.message : String(error)).trim();
            const reason = signal.aborted
              ? "Waiting for subagents was cancelled."
              : `Could not wait for subagents: ${errorMessage || "unknown error"}`;
            const presentation = signal.aborted
              ? buildToolRunPresentation({
                  toolName: TOOL_NAME_WAIT_FOR_AGENTS,
                  subject: dedupedTarget,
                })
              : buildSubagentPresentation({
                  toolName: TOOL_NAME_WAIT_FOR_AGENTS,
                  subject: dedupedTarget,
                  output: reason,
                });
            const uiEvent: ToolActivity = {
              type: "tool_call_finished",
              toolCallId: toolCall.id,
              toolName: TOOL_NAME_WAIT_FOR_AGENTS,
              presentation,
              status: "error",
            };
            const outcome = createTextToolOutcome(reason, signal.aborted ? "cancelled" : "failed");
            return { content: outcome.content, outcome: outcome.outcome, uiEvent };
          }
        },
        {
          type: "tool_call_started",
          toolCallId: toolCall.id,
          toolName: TOOL_NAME_WAIT_FOR_AGENTS,
          presentation: buildToolRunPresentation({
            toolName: TOOL_NAME_WAIT_FOR_AGENTS,
            subject: dedupedTarget,
          }),
        },
      );
    },
  };
}
