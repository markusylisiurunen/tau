import type { Tool, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { getSubagentDefinitionFromString } from "../subagents/registry.js";
import { runSubagentToCompletion } from "../subagents/subagent_engine.js";
import type { SubagentPersonaConfig, SubagentRuntimeDefinition } from "../subagents/types.js";
import type { RiskLevel } from "../types.js";
import { createToolError, createToolResult } from "../utils/messages.js";
import type {
  ToolDefinition,
  ToolDispatchContext,
  ToolDispatchResult,
  ToolDispatchResultWithPhases,
  ToolUiEvent,
} from "./registry.js";

const TASK_DESCRIPTION = [
  "Run an isolated sub-agent task to completion and return only its final text output.",
  "Use this to delegate narrow exploration or focused work to a constrained sub-agent.",
].join(" ");

const TASK_NAME_DESCRIPTION = "Sub-agent name to run (e.g., 'explore').";
const TASK_TITLE_DESCRIPTION = "A short UI title shown while the task runs.";
const TASK_PROMPT_DESCRIPTION = "The prompt to send to the sub-agent.";

export const TASK_TOOL: Tool = {
  name: "task",
  description: TASK_DESCRIPTION,
  parameters: Type.Object(
    {
      name: Type.String({ description: TASK_NAME_DESCRIPTION }),
      title: Type.String({ description: TASK_TITLE_DESCRIPTION }),
      prompt: Type.String({ description: TASK_PROMPT_DESCRIPTION }),
    },
    { additionalProperties: false },
  ),
};

function parseTaskArgs(raw: unknown): { name: string; title: string; prompt: string } {
  const args = raw as { name?: unknown; title?: unknown; prompt?: unknown } | undefined;
  const name = typeof args?.name === "string" ? args.name.trim() : "";
  const title = typeof args?.title === "string" ? args.title.trim() : "";
  const prompt = typeof args?.prompt === "string" ? args.prompt.trim() : "";
  return { name, title, prompt };
}

type TaskStatus = "success" | "error" | "aborted";

class AsyncUiEventQueue implements AsyncIterable<ToolUiEvent> {
  private readonly buffered: ToolUiEvent[] = [];
  private readonly waiting: Array<(result: IteratorResult<ToolUiEvent>) => void> = [];
  private closed = false;

  push(event: ToolUiEvent): void {
    if (this.closed) return;
    const next = this.waiting.shift();
    if (next) {
      next({ value: event, done: false });
      return;
    }
    this.buffered.push(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const resolve of this.waiting.splice(0)) {
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<ToolUiEvent> {
    return {
      next: () => {
        if (this.buffered.length > 0) {
          return Promise.resolve({ value: this.buffered.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<ToolUiEvent>>((resolve) => this.waiting.push(resolve));
      },
    };
  }
}

function getEnabledSubagentConfig(
  context: ToolDispatchContext | undefined,
  definition: SubagentRuntimeDefinition,
): SubagentPersonaConfig | undefined {
  const persona = context?.persona;
  const config = persona?.subagents;
  return config?.[definition.name];
}

export function createTaskToolDefinition(): ToolDefinition {
  return {
    schema: TASK_TOOL,
    async dispatch(
      toolCall: ToolCall,
      riskLevel: RiskLevel,
      signal?: AbortSignal,
      context?: ToolDispatchContext,
    ): Promise<ToolDispatchResult | ToolDispatchResultWithPhases> {
      const { name, title, prompt } = parseTaskArgs(toolCall.arguments);

      const blocked = (reason: string, details?: { name?: string; title?: string }) => {
        const toolResult = createToolError(toolCall, reason);
        const uiEvent: ToolUiEvent = {
          type: "task_blocked",
          toolCallId: toolCall.id,
          name: details?.name ?? (name || undefined),
          title: details?.title ?? (title || "(task)"),
          reason,
        };
        return { kind: "single", toolResult, uiEvent } satisfies ToolDispatchResult;
      };

      if (riskLevel === "none") {
        return blocked(
          "Task tool blocked due to risk level being set to 'none'. Ask the user to enable it with /risk:read-only or /risk:read-write.",
        );
      }

      if (!name || !title || !prompt) {
        const missing = [
          !name ? "name" : undefined,
          !title ? "title" : undefined,
          !prompt ? "prompt" : undefined,
        ].filter(Boolean);
        return blocked(`Task tool error: missing required parameter(s): ${missing.join(", ")}.`, {
          title: title || "(task)",
        });
      }

      if (!context?.persona.subagents || Object.keys(context.persona.subagents).length === 0) {
        return blocked("Task tool is not enabled for the current persona.", { name, title });
      }

      const definition = getSubagentDefinitionFromString(name);
      if (!definition) {
        return blocked(`Unknown sub-agent '${name}'.`, { name, title });
      }

      const personaConfig = getEnabledSubagentConfig(context, definition);
      if (!personaConfig) {
        return blocked(`Sub-agent '${definition.name}' is not enabled for the current persona.`, {
          name: definition.name,
          title,
        });
      }

      const uiQueue = new AsyncUiEventQueue();
      const lastEvents: string[] = [];
      let costTotal = 0;

      const pushProgress = (eventText: string, nextCostTotal: number) => {
        costTotal = nextCostTotal;
        lastEvents.push(eventText);
        while (lastEvents.length > 4) lastEvents.shift();
        uiQueue.push({
          type: "task_progress",
          toolCallId: toolCall.id,
          name: definition.name,
          title,
          lastEvents: [...lastEvents],
          costTotal,
        });
      };

      const run = (async (): Promise<ToolDispatchResult> => {
        let status: TaskStatus = "success";
        let finalText = "";

        try {
          const result = await runSubagentToCompletion({
            definition,
            personaConfig,
            prompt,
            config: context.config,
            signal: signal ?? new AbortController().signal,
            onProgress: (e) => pushProgress(e.text, e.costTotal),
          });
          finalText = result.finalText;
          costTotal = result.costTotal;
        } catch (err) {
          if (signal?.aborted) {
            status = "aborted";
            finalText = "Task aborted.";
          } else {
            status = "error";
            finalText = `Task failed: ${err instanceof Error ? err.message : String(err)}`;
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
          name: definition.name,
          title,
          lastEvents: [...lastEvents],
          costTotal,
          status,
        };

        return { kind: "single", toolResult, uiEvent };
      })();

      return {
        kind: "phased",
        startedUiEvent: {
          type: "task_started",
          toolCallId: toolCall.id,
          name: definition.name,
          title,
        },
        uiEvents: uiQueue,
        run,
      };
    },
  };
}
