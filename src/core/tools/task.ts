import type { ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import { z } from "zod";
import { getSubagentDefinitionFromString } from "../subagents/registry.js";
import { runSubagentToCompletion } from "../subagents/subagent_engine.js";
import type { SubagentPersonaConfig, SubagentRuntimeDefinition } from "../subagents/types.js";
import type { RiskLevel } from "../types.js";
import { createToolError, createToolResult } from "../utils/messages.js";
import { AsyncUiEventQueue } from "../utils/subagent_utils.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import type {
  ToolDefinition,
  ToolDispatchContext,
  ToolDispatchResult,
  ToolDispatchResultWithPhases,
  ToolUiEvent,
} from "./registry.js";
import { TASK_TOOL } from "./task_schema.js";

const taskArgsSchema = z.object({
  name: z.string().trim().catch(""),
  title: z.string().trim().catch(""),
  prompt: z.string().trim().catch(""),
});

function parseTaskArgs(raw: unknown): { name: string; title: string; prompt: string } {
  const parsed = taskArgsSchema.safeParse(raw);
  return parsed.success ? parsed.data : { name: "", title: "", prompt: "" };
}

type TaskStatus = "success" | "error" | "aborted";

function getEnabledSubagentConfig(
  context: ToolDispatchContext | undefined,
  definition: SubagentRuntimeDefinition,
): SubagentPersonaConfig | undefined {
  const persona = context?.persona;
  const config = persona?.subagents;
  return config?.[definition.name];
}

export function createTaskToolDefinition(backend: ToolExecutionBackend): ToolDefinition {
  return {
    schema: TASK_TOOL,
    async dispatch(
      toolCall: ToolCall,
      _riskLevel: RiskLevel,
      signal?: AbortSignal,
      context?: ToolDispatchContext,
    ): Promise<ToolDispatchResult | ToolDispatchResultWithPhases> {
      const { name, title, prompt } = parseTaskArgs(toolCall.arguments);

      const blocked = (reason: string, details?: { name?: string; title?: string }) => {
        const toolResult = createToolError(toolCall, reason);
        const uiEvent: ToolUiEvent = {
          type: "task_blocked",
          toolCallId: toolCall.id,
          kind: "task",
          name: details?.name ?? (name || undefined),
          title: details?.title ?? (title || "(task)"),
          reason,
        };
        return { kind: "single", toolResult, uiEvent } satisfies ToolDispatchResult;
      };

      if (!name || !title || !prompt) {
        const missing = [
          !name ? "name" : undefined,
          !title ? "title" : undefined,
          !prompt ? "prompt" : undefined,
        ].filter(Boolean);
        return blocked(`missing required parameter(s): ${missing.join(", ")}.`, {
          title: title || "(task)",
        });
      }

      if (!context?.persona.subagents || Object.keys(context.persona.subagents).length === 0) {
        return blocked("task tool is not enabled for the current persona.", { name, title });
      }

      const definition = getSubagentDefinitionFromString(name);
      if (!definition) {
        return blocked(`unknown sub-agent '${name}'.`, { name, title });
      }

      const personaConfig = getEnabledSubagentConfig(context, definition);
      if (!personaConfig) {
        return blocked(`sub-agent '${definition.name}' is not enabled for the current persona.`, {
          name: definition.name,
          title,
        });
      }

      const uiQueue = new AsyncUiEventQueue<ToolUiEvent>();
      let costTotal = 0;
      let turns = 0;
      let toolCalls = 0;

      const pushProgress = (
        eventText: string,
        nextCostTotal: number,
        nextTurns: number,
        nextToolCalls: number,
      ) => {
        costTotal = nextCostTotal;
        turns = nextTurns;
        toolCalls = nextToolCalls;
        uiQueue.push({
          type: "task_progress",
          toolCallId: toolCall.id,
          kind: "task",
          name: definition.name,
          title,
          event: eventText,
          costTotal,
          turns,
          toolCalls,
        });
      };

      const run = (async (): Promise<ToolDispatchResult> => {
        let status: TaskStatus = "success";
        let finalText = "";

        try {
          // Emit task started event
          pushProgress("task started", 0, 0, 0);

          const result = await runSubagentToCompletion({
            definition,
            personaConfig,
            prompt,
            config: context.config,
            authPath: context.authPath,
            backend,
            signal: signal ?? new AbortController().signal,
            onProgress: (e) => pushProgress(e.text, e.costTotal, e.turns, e.toolCalls),
          });
          const text = result.finalText.trim();
          if (!text) {
            throw new Error("sub-agent returned an empty response");
          }
          finalText = text;
          costTotal = result.costTotal;
        } catch (err) {
          if (signal?.aborted) {
            status = "aborted";
            finalText = "task aborted";
          } else {
            status = "error";
            finalText = `task failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        } finally {
          uiQueue.close();
        }

        const toolResult: ToolResultMessage =
          status === "success"
            ? createToolResult(toolCall, finalText, false)
            : createToolResult(toolCall, finalText, true);

        const uiEvent: ToolUiEvent = {
          type: "task_finished",
          toolCallId: toolCall.id,
          kind: "task",
          name: definition.name,
          title,
          costTotal,
          turns,
          toolCalls,
          status,
          finalOutput: finalText,
        };

        return { kind: "single", toolResult, uiEvent };
      })();

      return {
        kind: "phased",
        startedUiEvent: {
          type: "task_started",
          toolCallId: toolCall.id,
          kind: "task",
          name: definition.name,
          title,
        },
        uiEvents: uiQueue,
        run,
      };
    },
  };
}

export { TASK_TOOL };
