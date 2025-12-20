import type {
  AssistantMessage,
  Message,
  Tool,
  ToolCall,
  ToolResultMessage,
} from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { z } from "zod";
import { SessionEngine } from "../session/session_engine.js";
import type { RiskLevel } from "../types.js";
import { createToolError, createToolResult, extractAssistantText } from "../utils/messages.js";
import {
  AsyncUiEventQueue,
  extractAssistantTextForProgress,
  formatToolUiEventForProgress,
  getToolResultFirstLine,
} from "../utils/subagent_utils.js";
import type {
  ToolDefinition,
  ToolDispatchContext,
  ToolDispatchResult,
  ToolDispatchResultWithPhases,
  ToolUiEvent,
} from "./registry.js";

const FORK_DESCRIPTION = [
  "Fork the current session and run autonomously until it produces a final assistant response.",
  "The fork receives the full main thread history, appends the provided prompt as the next user message,",
  "and returns the final assistant text output from the fork.",
  "Only use this tool when the user specifically requests that the session be forked.",
].join(" ");

const FORK_TITLE_DESCRIPTION = [
  "A short human-friendly UI title shown while the fork runs.",
  "Do not use title case; all lower-case is preferred except for proper nouns.",
].join(" ");

const FORK_PROMPT_DESCRIPTION = [
  "The prompt to append as the next user message in the forked session.",
  "The fork will then run autonomously until completion.",
  "Format this as a direct instruction to the assistant.",
  "Be precise rather than loose in your phrasing.",
  "Include any instructions specifying what the assistant should return in its final response.",
].join(" ");

export const FORK_TOOL: Tool = {
  name: "fork",
  description: FORK_DESCRIPTION,
  parameters: Type.Object(
    {
      title: Type.String({ description: FORK_TITLE_DESCRIPTION }),
      prompt: Type.String({ description: FORK_PROMPT_DESCRIPTION }),
    },
    { additionalProperties: false },
  ),
};

const forkArgsSchema = z.object({
  title: z.string().trim().catch(""),
  prompt: z.string().trim().catch(""),
});

function parseForkArgs(raw: unknown): { title: string; prompt: string } {
  const parsed = forkArgsSchema.safeParse(raw);
  return parsed.success ? parsed.data : { title: "", prompt: "" };
}

type ForkStatus = "success" | "error" | "aborted";

function stripToolCallFromHistory(history: readonly Message[], toolCallId: string): Message[] {
  const copied = [...history];

  for (let i = copied.length - 1; i >= 0; i--) {
    const msg = copied[i];
    if (!msg || msg.role !== "assistant") {
      continue;
    }

    const assistant = msg as AssistantMessage;
    const hasCall = assistant.content.some((b) => b.type === "toolCall" && b.id === toolCallId);
    if (!hasCall) {
      continue;
    }

    const nextContent = assistant.content.filter((b) => b.type !== "toolCall");
    if (nextContent.length === 0) {
      copied.splice(i, 1);
    } else {
      copied[i] = { ...assistant, content: nextContent };
    }

    break;
  }

  return copied;
}

export function createForkToolDefinition(): ToolDefinition {
  return {
    schema: FORK_TOOL,
    async dispatch(
      toolCall: ToolCall,
      riskLevel: RiskLevel,
      signal?: AbortSignal,
      context?: ToolDispatchContext,
    ): Promise<ToolDispatchResult | ToolDispatchResultWithPhases> {
      const { title, prompt } = parseForkArgs(toolCall.arguments);

      const blocked = (reason: string, details?: { title?: string }) => {
        const toolResult = createToolError(toolCall, reason);
        const uiEvent: ToolUiEvent = {
          type: "task_blocked",
          toolCallId: toolCall.id,
          kind: "fork",
          title: details?.title ?? (title || "(fork)"),
          reason,
        };
        return { kind: "single", toolResult, uiEvent } satisfies ToolDispatchResult;
      };

      if (riskLevel === "none") {
        return blocked(
          "Fork tool blocked due to risk level being set to 'none'. Ask the user to enable it with /risk:read-only or /risk:read-write.",
        );
      }

      if (!title || !prompt) {
        const missing = [!title ? "title" : undefined, !prompt ? "prompt" : undefined].filter(
          Boolean,
        );
        return blocked(`Fork tool error: missing required parameter(s): ${missing.join(", ")}.`, {
          title: title || "(fork)",
        });
      }

      if (!context) {
        return blocked("Fork tool error: missing session context.", { title });
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
          kind: "fork",
          name: "",
          title,
          event: eventText,
          costTotal,
          turns,
          toolCalls,
        });
      };

      const run = (async (): Promise<ToolDispatchResult> => {
        let status: ForkStatus = "success";
        let finalText = "";

        try {
          pushProgress("fork started", 0, 0, 0);

          const runSignal = signal ?? new AbortController().signal;

          const enabledTools = context.persona.tools ?? context.toolRegistry.schemas;
          const forkTools = enabledTools.filter((t) => t.name !== "task" && t.name !== "fork");
          const forkPersona = { ...context.persona, tools: forkTools };

          const forkHistory = stripToolCallFromHistory(context.history, toolCall.id);

          const forkEngine = new SessionEngine({
            persona: forkPersona,
            systemPrompt: context.systemPrompt,
            riskLevel,
            toolRegistry: context.toolRegistry,
            config: context.config,
          });

          for (const msg of forkHistory) {
            forkEngine.addMessage(msg);
          }
          forkEngine.addUserText(
            [
              "<system>",
              [
                "You are running in a forked session with access to the same tools and capabilities as the main session.",
                "Execute the following instruction autonomously until you have a complete answer.",
                "Your final message will be returned to the user, so ensure it is complete and self-contained,",
                "describing what you did and providing any requested information.",
                "Do not stop until you have a final answer ready to return.",
              ].join(" "),
              "</system>",
              prompt,
            ].join("\n"),
          );

          let lastAssistantFinal: AssistantMessage | undefined;

          for await (const event of forkEngine.processTurn(runSignal)) {
            if (runSignal.aborted) {
              break;
            }

            if (event.type === "assistant_final") {
              lastAssistantFinal = event.message;
              turns += 1;
              costTotal += event.message.usage?.cost?.total ?? 0;
              toolCalls += event.message.content.filter((c) => c.type === "toolCall").length;

              const agentLine = extractAssistantTextForProgress(event.message);
              if (agentLine) {
                pushProgress(agentLine, costTotal, turns, toolCalls);
              }
            } else if (event.type === "tool_ui") {
              const uiEvent = event.uiEvent;
              const text = formatToolUiEventForProgress(uiEvent);
              if (text) {
                pushProgress(text, costTotal, turns, toolCalls);
              }
            } else if (event.type === "tool_result") {
              if (event.message.isError) {
                const firstLine = getToolResultFirstLine(event.message);
                const issue = firstLine
                  ? `${event.message.toolName}: ${firstLine}`
                  : `${event.message.toolName}: tool returned an error`;
                pushProgress(`tool error: ${issue}`, costTotal, turns, toolCalls);
              }
            } else if (event.type === "notice") {
              if (event.severity === "error") {
                pushProgress(`tool error: ${event.text}`, costTotal, turns, toolCalls);
              }
            }
          }

          if (runSignal.aborted) {
            status = "aborted";
            finalText = "Fork aborted.";
          } else if (!lastAssistantFinal) {
            throw new Error("fork did not produce a final response");
          } else if (lastAssistantFinal.stopReason === "toolUse") {
            throw new Error("fork stopped without producing a final non-tool response");
          } else {
            const text = extractAssistantText(lastAssistantFinal).trim();
            if (!text) {
              throw new Error(
                `fork produced an empty response (stopReason: ${lastAssistantFinal.stopReason ?? "unknown"})`,
              );
            }
            finalText = text;
          }
        } catch (err) {
          if (signal?.aborted) {
            status = "aborted";
            finalText = "Fork aborted.";
          } else {
            status = "error";
            finalText = `Fork failed: ${err instanceof Error ? err.message : String(err)}`;
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
          kind: "fork",
          name: "",
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
          kind: "fork",
          name: "",
          title,
        },
        uiEvents: uiQueue,
        run,
      };
    },
  };
}
