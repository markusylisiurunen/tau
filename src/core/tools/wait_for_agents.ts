import type { Tool, ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { z } from "zod";
import type { AgentSupervisor } from "../subagents/agent_supervisor.js";
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
  "Returns compact state without conversation content. Read responses and tool evidence with tau.agents.trace and tau.agents.readText in code.",
].join(" ");

const WAIT_FOR_AGENTS_IDS_DESCRIPTION = "List of single-line subagent ids to wait for.";

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

function buildWaitDetails(states: SubagentStateSnapshot[]): ToolCardLineInput[] {
  return states.map((state) => ({ text: `${state.id} · ${state.title} · ${state.run.status}` }));
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
            const agents = await supervisor.waitForAgents(ids, signal);
            const states = agents.map((state) => supervisor.getSnapshot(state.id)!);
            const resultText = JSON.stringify({
              ready: agents.filter((state) => state.status === "idle").map((state) => state.id),
              agents,
            });
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
