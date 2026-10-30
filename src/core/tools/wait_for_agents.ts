import type { Tool, ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { z } from "zod";
import type { AgentSupervisor } from "../subagents/agent_supervisor.js";
import type { SubagentStateSnapshot } from "../subagents/types.js";
import { truncateForTokens } from "../utils/truncate.js";
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
  "Wait until at least one of the requested subagents is idle, then return the state of every requested subagent.",
  "For an idle subagent, the result also contains the last assistant message from its latest turn. A subagent that is not idle gets state only.",
  "response_seq is that message's trace seq: read more retained text with tau.agents.readText({ id, seq }) in code, and tool evidence with tau.agents.trace.",
  "response_complete is false when the text was shortened to fit the output budget or is no longer fully available.",
  "response_partial is true when the turn failed or was interrupted, so the message may not be a final answer.",
  "response: none means the latest turn produced no assistant message.",
].join(" ");

const WAIT_FOR_AGENTS_IDS_DESCRIPTION = "List of single-line subagent ids to wait for.";

export const WAIT_FOR_AGENTS_TOOL: Tool = {
  name: TOOL_NAME_WAIT_FOR_AGENTS,
  description: WAIT_FOR_AGENTS_DESCRIPTION,
  parameters: Type.Object(
    {
      maxOutputTokens: Type.Optional(
        Type.Integer({
          description:
            "Estimated token budget for response text, split evenly across the requested subagents. Default 8192.",
          minimum: 1,
          maximum: 65536,
        }),
      ),
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
    maxOutputTokens: z.number().int().min(1).max(65536).optional(),
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
            const outputBudget = Math.floor((parsedArgs.data.maxOutputTokens ?? 8192) / ids.length);
            const resultText = agents
              .map((agent) => {
                const lines = [
                  `id: ${agent.id}`,
                  `title: ${JSON.stringify(agent.title)}`,
                  `status: ${agent.status}`,
                  ...(agent.status === "idle" ? [`reason: ${agent.reason}`] : []),
                  `pending: queue=${agent.pending.queue} steer=${agent.pending.steer}`,
                ];
                if (agent.status !== "idle") return lines.join("\n");
                if (agent.reason === "failed") lines.push(`error: ${JSON.stringify(agent.error)}`);
                const response = supervisor.getLastResponse(agent.id);
                if (!response) {
                  lines.push("response: none");
                } else {
                  const output = truncateForTokens(response.text, { maxTokens: outputBudget });
                  lines.push(
                    `response_seq: ${response.seq}`,
                    `response_complete: ${response.complete && !output.truncated}`,
                    `response_partial: ${agent.reason !== "completed"}`,
                    "",
                    "--- response ---",
                    output.content,
                  );
                }
                return lines.join("\n");
              })
              .join("\n\n");
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
