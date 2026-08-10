import type { Tool, ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { z } from "zod";
import type { AgentSupervisor } from "../subagents/agent_supervisor.js";
import { formatSendInputToAgentResult } from "../subagents/format.js";
import type { SubagentStateSnapshot } from "../subagents/types.js";
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
import { buildSubagentPresentation } from "./subagent_ui.js";
import { TOOL_NAME_SEND_INPUT_TO_AGENT } from "./tool_names.js";

const SEND_INPUT_TO_AGENT_DESCRIPTION = [
  "Send a follow-up prompt to an existing subagent.",
  "The subagent must be idle before you can send another input.",
  "Starting a new run replaces the previously retained response.",
].join(" ");

const SEND_INPUT_TO_AGENT_ID_DESCRIPTION = "Single-line subagent id to send input to.";

const SEND_INPUT_TO_AGENT_PROMPT_DESCRIPTION = [
  "The prompt to send to the subagent.",
  "Include all necessary context and instructions for the next run.",
].join(" ");

export const SEND_INPUT_TO_AGENT_TOOL: Tool = {
  name: TOOL_NAME_SEND_INPUT_TO_AGENT,
  description: SEND_INPUT_TO_AGENT_DESCRIPTION,
  parameters: Type.Object(
    {
      id: Type.String({
        description: SEND_INPUT_TO_AGENT_ID_DESCRIPTION,
        pattern: "^[^\\r\\n]+$",
      }),
      prompt: Type.String({ description: SEND_INPUT_TO_AGENT_PROMPT_DESCRIPTION }),
    },
    { additionalProperties: false },
  ),
};

const sendInputArgsSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .refine((id) => !/[\r\n]/.test(id), "Subagent ID must be a single line."),
  prompt: z.string().trim().min(1),
});

function resolveSnapshotTarget(snapshot: SubagentStateSnapshot) {
  return { name: snapshot.name, title: snapshot.title };
}

function getSendInputSubject(raw: unknown, supervisor: AgentSupervisor): string {
  const parsedArgs = parseToolArgs(sendInputArgsSchema, raw);
  if (!parsedArgs.ok) {
    return "(invalid arguments)";
  }
  const { id } = parsedArgs.data;
  return supervisor.getSnapshot(id)?.title ?? id;
}

export function createSendInputToAgentToolDefinition(supervisor: AgentSupervisor): AgentTool {
  return {
    schema: SEND_INPUT_TO_AGENT_TOOL,
    describe: (toolCall) => {
      const subject = getSendInputSubject(toolCall.arguments, supervisor);
      return {
        presentation: buildToolRunPresentation({
          toolName: TOOL_NAME_SEND_INPUT_TO_AGENT,
          subject,
        }),
      };
    },
    async execute(
      toolCall: ToolCall,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionOutcome> {
      const { signal } = context;
      let id = "";
      let prompt = "";
      const subject = getSendInputSubject(toolCall.arguments, supervisor);

      const blocked = (reason: string, details?: { title?: string }) => {
        const outcome = createTextToolOutcome(reason, "blocked");
        const uiEvent: ToolActivity = {
          type: "tool_call_blocked",
          toolCallId: toolCall.id,
          toolName: TOOL_NAME_SEND_INPUT_TO_AGENT,
          presentation: buildToolRunPresentation({
            toolName: TOOL_NAME_SEND_INPUT_TO_AGENT,
            subject: details?.title ?? subject,
            details: [{ text: reason }],
          }),
          reason,
        };
        return {
          content: outcome.content,
          outcome: outcome.outcome,
          uiEvent,
        } satisfies ToolImplementationOutcome;
      };

      const parsedArgs = parseToolArgs(sendInputArgsSchema, toolCall.arguments);
      if (!parsedArgs.ok) {
        return executeTool(context, () => blocked(`Invalid arguments: ${parsedArgs.error}`));
      }

      ({ id, prompt } = parsedArgs.data);

      const snapshot = supervisor.getSnapshot(id);
      if (!snapshot) {
        return executeTool(context, () => blocked(`Unknown subagent ID: ${id}`, { title: id }));
      }

      const target = resolveSnapshotTarget(snapshot);

      return executeTool(
        context,
        async (): Promise<ToolImplementationOutcome> => {
          if (signal?.aborted) {
            const reason = "Aborted.";
            const outcome = createTextToolOutcome(reason, "cancelled");
            const presentation = buildToolRunPresentation({
              toolName: TOOL_NAME_SEND_INPUT_TO_AGENT,
              subject: target.title,
            });
            const uiEvent: ToolActivity = {
              type: "tool_call_finished",
              toolCallId: toolCall.id,
              toolName: TOOL_NAME_SEND_INPUT_TO_AGENT,
              presentation,
              status: "error",
            };
            return { content: outcome.content, outcome: outcome.outcome, uiEvent };
          }

          const sendResult = supervisor.sendInput({ id, prompt });

          if (!sendResult.ok) {
            const outcome = createTextToolOutcome(sendResult.reason, "blocked");
            const uiEvent: ToolActivity = {
              type: "tool_call_blocked",
              toolCallId: toolCall.id,
              toolName: TOOL_NAME_SEND_INPUT_TO_AGENT,
              presentation: buildToolRunPresentation({
                toolName: TOOL_NAME_SEND_INPUT_TO_AGENT,
                subject: target.title,
                details: [{ text: sendResult.reason }],
              }),
              reason: sendResult.reason,
            };
            return { content: outcome.content, outcome: outcome.outcome, uiEvent };
          }

          const resultText = formatSendInputToAgentResult(sendResult.state, sendResult.capacity);
          const outcome = createTextToolOutcome(resultText, "succeeded");
          const presentation = buildSubagentPresentation({
            toolName: TOOL_NAME_SEND_INPUT_TO_AGENT,
            subject: sendResult.state.title,
            output: prompt,
            detailTruncation: false,
          });
          const uiEvent: ToolActivity = {
            type: "tool_call_finished",
            toolCallId: toolCall.id,
            toolName: TOOL_NAME_SEND_INPUT_TO_AGENT,
            presentation,
            status: "success",
          };
          return { content: outcome.content, outcome: outcome.outcome, uiEvent };
        },
        {
          type: "tool_call_started",
          toolCallId: toolCall.id,
          toolName: TOOL_NAME_SEND_INPUT_TO_AGENT,
          presentation: buildToolRunPresentation({
            toolName: TOOL_NAME_SEND_INPUT_TO_AGENT,
            subject: target.title,
          }),
        },
      );
    },
  };
}
