import type { Tool, ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { z } from "zod";
import type { AgentSupervisor } from "../subagents/agent_supervisor.js";
import { formatSendInputToAgentResult } from "../subagents/format.js";
import type { SubagentStateSnapshot } from "../subagents/types.js";
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
import { buildSubagentUiText } from "./subagent_ui.js";
import { TOOL_NAME_SEND_INPUT_TO_AGENT } from "./tool_names.js";

const SEND_INPUT_TO_AGENT_DESCRIPTION = [
  "Send a follow-up prompt to an existing subagent.",
  "The subagent must be idle before you can send another input.",
  "Starting a new run replaces the previously retained response.",
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
  id: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
});

function resolveSnapshotTarget(snapshot: SubagentStateSnapshot) {
  return { name: snapshot.name, title: snapshot.title };
}

function getSendInputDisplayTarget(raw: unknown, supervisor: AgentSupervisor): string {
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
    describe: (toolCall) => ({
      headerTarget: getSendInputDisplayTarget(toolCall.arguments, supervisor),
    }),
    async execute(
      toolCall: ToolCall,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionOutcome> {
      const { signal } = context;
      let id = "";
      let prompt = "";
      const headerTarget = getSendInputDisplayTarget(toolCall.arguments, supervisor);

      const blocked = (
        reason: string,
        details?: { id?: string; name?: string; title?: string },
      ) => {
        const outcome = createTextToolOutcome(reason, "blocked");
        const uiEvent: ToolActivity = {
          type: "send_input_to_agent_blocked",
          toolCallId: toolCall.id,
          agentId: details?.id ?? (id || undefined),
          name: details?.name ?? undefined,
          title: details?.title ?? headerTarget,
          headerTarget: details?.title ?? headerTarget,
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
        return executeTool(context, () => blocked(`Unknown subagent ID: ${id}`, { id, title: id }));
      }

      const target = resolveSnapshotTarget(snapshot);

      return executeTool(
        context,
        async (): Promise<ToolImplementationOutcome> => {
          if (signal?.aborted) {
            const reason = "Aborted.";
            const outcome = createTextToolOutcome(reason, "cancelled");
            const uiText = buildSubagentUiText({
              output: reason,
              statusText: `${target.name} · ${id}`,
              maxOutputLines: 16,
              fullText: reason,
            });
            const uiEvent: ToolActivity = {
              type: "send_input_to_agent_finished",
              toolCallId: toolCall.id,
              agentId: id,
              name: target.name,
              title: target.title,
              headerTarget: target.title,
              status: "error",
              message: reason,
              uiText,
            };
            return { content: outcome.content, outcome: outcome.outcome, uiEvent };
          }

          const sendResult = supervisor.sendInput({ id, prompt });

          if (!sendResult.ok) {
            const outcome = createTextToolOutcome(sendResult.reason, "blocked");
            const uiEvent: ToolActivity = {
              type: "send_input_to_agent_blocked",
              toolCallId: toolCall.id,
              agentId: id,
              name: target.name,
              title: target.title,
              headerTarget: target.title,
              reason: sendResult.reason,
            };
            return { content: outcome.content, outcome: outcome.outcome, uiEvent };
          }

          const resultText = formatSendInputToAgentResult(sendResult.state, sendResult.capacity);
          const outcome = createTextToolOutcome(resultText, "succeeded");
          const uiText = buildSubagentUiText({
            output: prompt,
            statusText: `${sendResult.state.name} · ${sendResult.state.id}`,
            maxOutputLines: 16,
            fullText: resultText,
          });
          const uiEvent: ToolActivity = {
            type: "send_input_to_agent_finished",
            toolCallId: toolCall.id,
            agentId: sendResult.state.id,
            name: sendResult.state.name,
            title: sendResult.state.title,
            headerTarget: sendResult.state.title,
            status: "success",
            uiText,
          };
          return { content: outcome.content, outcome: outcome.outcome, uiEvent };
        },
        {
          type: "send_input_to_agent_started",
          toolCallId: toolCall.id,
          agentId: id,
          name: target.name,
          title: target.title,
          headerTarget: target.title,
        },
      );
    },
  };
}
