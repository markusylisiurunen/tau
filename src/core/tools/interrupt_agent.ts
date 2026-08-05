import type { Tool, ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { z } from "zod";
import type { AgentSupervisor } from "../subagents/agent_supervisor.js";
import { formatInterruptAgentResult } from "../subagents/format.js";
import { parseToolArgs } from "../utils/zod.js";
import type { ToolActivity } from "./activity.js";
import { buildToolRunPresentation } from "./presentation.js";
import {
  type AgentTool,
  createTextToolOutcome,
  executeTool,
  type ToolExecutionContext,
  type ToolExecutionOutcome,
  type ToolImplementationOutcome,
} from "./registry.js";
import { buildSubagentPresentation, formatSubagentMetadata } from "./subagent_ui.js";
import { TOOL_NAME_INTERRUPT_AGENT } from "./tool_names.js";

const INTERRUPT_AGENT_DESCRIPTION = [
  "Interrupt the current run of a subagent and return its latest state.",
  "The subagent thread remains available for follow-up input.",
  "If the subagent is already idle, this returns its latest state without changing it.",
].join(" ");

const INTERRUPT_AGENT_ID_DESCRIPTION = "Single-line subagent id to interrupt.";

export const INTERRUPT_AGENT_TOOL: Tool = {
  name: TOOL_NAME_INTERRUPT_AGENT,
  description: INTERRUPT_AGENT_DESCRIPTION,
  parameters: Type.Object(
    {
      id: Type.String({
        description: INTERRUPT_AGENT_ID_DESCRIPTION,
        pattern: "^[^\\r\\n]+$",
      }),
    },
    { additionalProperties: false },
  ),
};

const interruptArgsSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .refine((id) => !/[\r\n]/.test(id), "Subagent ID must be a single line."),
});

function getInterruptAgentSubject(raw: unknown): string {
  const parsedArgs = parseToolArgs(interruptArgsSchema, raw);
  return parsedArgs.ok ? parsedArgs.data.id : "(invalid arguments)";
}

export function createInterruptAgentToolDefinition(supervisor: AgentSupervisor): AgentTool {
  return {
    schema: INTERRUPT_AGENT_TOOL,
    describe: (toolCall) => {
      const subject = getInterruptAgentSubject(toolCall.arguments);
      return {
        presentation: buildToolRunPresentation({ toolName: TOOL_NAME_INTERRUPT_AGENT, subject }),
      };
    },
    async execute(
      toolCall: ToolCall,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionOutcome> {
      const { signal } = context;
      let id = "";
      const subject = getInterruptAgentSubject(toolCall.arguments);

      const blocked = (reason: string): ToolImplementationOutcome => {
        const outcome = createTextToolOutcome(reason, "blocked");
        const uiEvent: ToolActivity = {
          type: "tool_call_blocked",
          toolCallId: toolCall.id,
          toolName: TOOL_NAME_INTERRUPT_AGENT,
          presentation: buildToolRunPresentation({
            toolName: TOOL_NAME_INTERRUPT_AGENT,
            subject: subject,
            details: [{ text: reason, tone: "error" }],
            detailTruncation: false,
            truncateDetailLines: false,
          }),
          reason,
        };
        return { content: outcome.content, outcome: outcome.outcome, uiEvent };
      };

      const parsedArgs = parseToolArgs(interruptArgsSchema, toolCall.arguments);
      if (!parsedArgs.ok) {
        return executeTool(context, () => blocked(`Invalid arguments: ${parsedArgs.error}`));
      }

      ({ id } = parsedArgs.data);

      return executeTool(
        context,
        async (): Promise<ToolImplementationOutcome> => {
          try {
            const current = supervisor.getSnapshot(id);
            if (!current) {
              return blocked(`Unknown subagent ID: ${id}`);
            }
            const wasRunning = current.availability === "running";
            const state = await supervisor.interrupt(id, signal);
            if (!state) {
              return blocked(`Unknown subagent ID: ${id}`);
            }

            const resultText = formatInterruptAgentResult(
              state,
              supervisor.getCapacity(),
              wasRunning,
            );
            const durationMs =
              state.run.status === "running"
                ? undefined
                : Math.max(0, state.run.finishedAt - state.run.startedAt);
            const presentation = buildSubagentPresentation({
              toolName: TOOL_NAME_INTERRUPT_AGENT,
              subject: subject,
              output: resultText,
              detailTruncation: false,
              truncateDetailLines: false,
              metadata: formatSubagentMetadata({ costTotal: state.costTotal, durationMs }),
            });
            const uiEvent: ToolActivity = {
              type: "tool_call_finished",
              toolCallId: toolCall.id,
              toolName: TOOL_NAME_INTERRUPT_AGENT,
              presentation,
              status: "success",
            };
            const outcome = createTextToolOutcome(resultText, "succeeded");
            return { content: outcome.content, outcome: outcome.outcome, uiEvent };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const reason = message.trim() || "The interrupt_agent request failed.";
            const presentation = signal.aborted
              ? buildToolRunPresentation({
                  toolName: TOOL_NAME_INTERRUPT_AGENT,
                  subject,
                })
              : buildSubagentPresentation({
                  toolName: TOOL_NAME_INTERRUPT_AGENT,
                  subject,
                  output: reason,
                  detailTruncation: false,
                  truncateDetailLines: false,
                });
            const uiEvent: ToolActivity = {
              type: "tool_call_finished",
              toolCallId: toolCall.id,
              toolName: TOOL_NAME_INTERRUPT_AGENT,
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
          toolName: TOOL_NAME_INTERRUPT_AGENT,
          presentation: buildToolRunPresentation({
            toolName: TOOL_NAME_INTERRUPT_AGENT,
            subject: subject,
          }),
        },
      );
    },
  };
}
