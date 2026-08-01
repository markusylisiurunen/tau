import type { Tool, ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { z } from "zod";
import type { AgentSupervisor } from "../subagents/agent_supervisor.js";
import { formatSubagentStates } from "../subagents/format.js";
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
import { TOOL_NAME_LIST_AGENTS } from "./tool_names.js";

const LIST_AGENTS_DESCRIPTION = [
  "List all spawned subagents and their current state.",
  "Use this to rediscover agent ids and inspect availability, latest run outcome, progress, runtime, usage, context pressure, and response availability.",
].join(" ");

export const LIST_AGENTS_TOOL: Tool = {
  name: TOOL_NAME_LIST_AGENTS,
  description: LIST_AGENTS_DESCRIPTION,
  parameters: Type.Object({}, { additionalProperties: false }),
};

const listArgsSchema = z.object({}).strict();

export function createListAgentsToolDefinition(supervisor: AgentSupervisor): AgentTool {
  return {
    schema: LIST_AGENTS_TOOL,
    describe: () => ({ headerTarget: "subagents" }),
    async execute(
      toolCall: ToolCall,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionOutcome> {
      const blocked = (reason: string): ToolImplementationOutcome => {
        const outcome = createTextToolOutcome(reason, "blocked");
        const uiEvent: ToolActivity = {
          type: "list_agents_blocked",
          toolCallId: toolCall.id,
          headerTarget: "subagents",
          reason,
        };
        return { content: outcome.content, outcome: outcome.outcome, uiEvent };
      };

      const parsedArgs = parseToolArgs(listArgsSchema, toolCall.arguments);
      if (!parsedArgs.ok) {
        return executeTool(context, () => blocked(`Invalid arguments: ${parsedArgs.error}`));
      }

      return executeTool(
        context,
        (): ToolImplementationOutcome => {
          const states = supervisor.listSnapshots();
          const capacity = supervisor.getCapacity();
          const resultText = formatSubagentStates(states, capacity, { includeResponses: false });
          const outcome = createTextToolOutcome(resultText, "succeeded");
          const uiText = buildSubagentUiText({
            output: resultText,
            statusText: `running ${capacity.running}/${capacity.limit}`,
            maxOutputLines: 16,
            fullText: resultText,
          });
          const uiEvent: ToolActivity = {
            type: "list_agents_finished",
            toolCallId: toolCall.id,
            headerTarget: "subagents",
            status: "success",
            uiText,
          };
          return { content: outcome.content, outcome: outcome.outcome, uiEvent };
        },
        {
          type: "list_agents_started",
          toolCallId: toolCall.id,
          headerTarget: "subagents",
        },
      );
    },
  };
}
