import { randomUUID } from "node:crypto";
import type {
  AssistantMessage,
  Context,
  KnownProvider,
  Message,
  ToolCall,
} from "@mariozechner/pi-ai";
import type { Config } from "../config.js";
import { getApiKeyForProvider } from "../config.js";
import { type RunnerEvent, runModelSubturn, runToolCalls } from "../session/runner.js";
import { createBashToolDefinition } from "../tools/bash.js";
import type { ToolDefinition, ToolUiEvent } from "../tools/registry.js";
import { ToolRegistry } from "../tools/registry.js";
import { createWebFetchToolDefinition } from "../tools/web_fetch.js";
import { createWebSearchToolDefinition } from "../tools/web_search.js";
import type { RiskLevel } from "../types.js";
import { isFlexRetryEnabled } from "../utils/flex_retry.js";
import { extractAssistantText } from "../utils/messages.js";
import type { TauStreamOptions } from "../utils/streaming_settings.js";
import { parseStreamingSettings } from "../utils/streaming_settings.js";
import {
  extractAssistantTextForProgress,
  formatToolUiEventForProgress,
  getToolResultFirstLine,
  normalizeOneLine,
} from "../utils/subagent_utils.js";
import type {
  AllowedSubagentToolName,
  SubagentPersonaConfig,
  SubagentRuntimeDefinition,
} from "./types.js";

export type SubagentProgressEvent = {
  text: string;
  costTotal: number;
  turns: number;
  toolCalls: number;
};

export type SubagentRunResult = {
  finalText: string;
  costTotal: number;
};

function getStreamingSettings(settings: SubagentPersonaConfig["settings"]): TauStreamOptions {
  const merged = { ...(settings ?? {}) } as Record<string, unknown>;
  return parseStreamingSettings(merged);
}

function buildToolRegistryForAllowedTools(
  allowedTools: AllowedSubagentToolName[],
  config: Config,
): ToolRegistry {
  const definitions: ToolDefinition[] = [];

  for (const tool of allowedTools) {
    switch (tool) {
      case "bash":
        definitions.push(createBashToolDefinition());
        break;
      case "web_search":
        definitions.push(createWebSearchToolDefinition(config));
        break;
      case "web_fetch":
        definitions.push(createWebFetchToolDefinition(config));
        break;
    }
  }

  return new ToolRegistry(definitions);
}

function isToolCall(block: AssistantMessage["content"][number]): block is ToolCall {
  return block.type === "toolCall";
}

export async function runSubagentToCompletion(options: {
  definition: SubagentRuntimeDefinition;
  personaConfig: SubagentPersonaConfig;
  prompt: string;
  config: Config;
  signal: AbortSignal;
  onProgress?: (event: SubagentProgressEvent) => void;
}): Promise<SubagentRunResult> {
  const { definition, personaConfig, prompt, config, signal, onProgress } = options;

  if (signal.aborted) {
    throw new Error("sub-agent aborted");
  }

  const toolRegistry = buildToolRegistryForAllowedTools(definition.allowedTools, config);
  const messages: Message[] = [
    {
      role: "user",
      content: [{ type: "text", text: prompt }],
      timestamp: Date.now(),
    },
  ];

  let costTotal = 0;
  let turns = 0;
  let toolCalls = 0;
  const maxSubturns = definition.maxSubturns ?? 64;

  const emit = (text: string) => {
    onProgress?.({ text, costTotal, turns, toolCalls });
  };

  const issues: string[] = [];

  const recordIssue = (text: string) => {
    const normalized = normalizeOneLine(text);
    if (!normalized) return;
    issues.push(normalized);
  };

  const formatIssueSummary = (): string =>
    issues.length > 0 ? ` (recent issues: ${issues.slice(-3).join("; ")})` : "";

  const sessionId = `tau-subagent-${definition.name}-${randomUUID()}`;

  for (let subturn = 1; subturn <= maxSubturns && !signal.aborted; subturn++) {
    emit("assistant: thinking");

    const context: Context = {
      systemPrompt: definition.systemPrompt,
      messages,
      tools: toolRegistry.schemas,
    };

    const apiKey = getApiKeyForProvider(config, personaConfig.model.provider as KnownProvider);
    const baseOptions: TauStreamOptions = {
      ...getStreamingSettings(personaConfig.settings),
      signal,
      sessionId,
      serviceTier: undefined,
      ...(apiKey && { apiKey }),
    };

    const shouldRetryFlex = isFlexRetryEnabled({
      modelApi: personaConfig.model.api,
      serviceTier: baseOptions.serviceTier,
      signal,
    });

    const runner = runModelSubturn({
      model: personaConfig.model,
      context,
      streamOptions: baseOptions,
      signal,
      emitPartials: false,
      retry: {
        notice: { text: "assistant: retrying without service tier", severity: "info" },
        shouldRetryAfterError: () => shouldRetryFlex,
        shouldRetryAfterResponse: ({ finalMessage }) =>
          shouldRetryFlex && finalMessage.stopReason === "error",
      },
    });

    let finalMessage: AssistantMessage;
    try {
      finalMessage = await consumeRunner(runner, (event) => {
        if (event.type === "notice") {
          emit(event.text);
        }
      });
    } catch (err) {
      if (signal.aborted) {
        throw new Error("sub-agent aborted");
      }
      throw err;
    }

    messages.push(finalMessage);
    turns++;
    costTotal += finalMessage.usage?.cost?.total ?? 0;

    const messageToolCalls = finalMessage.content.filter(isToolCall);
    toolCalls += messageToolCalls.length;

    // Emit any assistant text output
    const agentText = extractAssistantTextForProgress(finalMessage);
    if (agentText) {
      emit(agentText);
    }

    const finish = () => {
      const finalText = extractAssistantText(finalMessage).trim();
      if (!finalText) {
        throw new Error(
          `sub-agent produced an empty response (stopReason: ${finalMessage.stopReason ?? "unknown"})${formatIssueSummary()}`,
        );
      }
      emit("done");
      return { finalText, costTotal };
    };

    if (finalMessage.stopReason !== "toolUse") {
      return finish();
    }

    if (messageToolCalls.length === 0) {
      return finish();
    }

    const riskLevel = definition.riskLevel as RiskLevel;

    const handleUi = (uiEvent: ToolUiEvent | undefined) => {
      if (!uiEvent) return;

      if (
        (uiEvent.type === "web_search_finished" || uiEvent.type === "web_fetch_finished") &&
        typeof uiEvent.costUsd === "number" &&
        Number.isFinite(uiEvent.costUsd) &&
        uiEvent.costUsd > 0
      ) {
        costTotal += uiEvent.costUsd;
      }

      const text = formatToolUiEventForProgress(uiEvent);
      if (text) {
        if (/\b(blocked|failed):/.test(text)) {
          recordIssue(text);
        }
        emit(text);
      }
    };

    const toolRunner = runToolCalls({
      toolCalls: messageToolCalls,
      toolRegistry,
      enabledTools: toolRegistry.getEnabledToolSchemas(riskLevel),
      riskLevel,
      signal,
      toolErrorMessages: {
        notEnabled: (toolCall) => `tool '${toolCall.name}' is not available to this sub-agent.`,
        unsupported: (toolCall) => `tool '${toolCall.name}' is not available to this sub-agent.`,
      },
    });

    for await (const event of toolRunner) {
      if (signal.aborted) break;

      if (event.type === "tool_ui") {
        handleUi(event.uiEvent);
        continue;
      }

      if (event.type === "tool_result") {
        messages.push(event.message);
        if (event.message.isError) {
          const firstLine = getToolResultFirstLine(event.message);
          const issue = firstLine
            ? `${event.message.toolName}: ${firstLine}`
            : `${event.message.toolName}: tool returned an error`;
          recordIssue(issue);
        }
        continue;
      }

      if (event.type === "notice") {
        if (event.severity === "error") {
          recordIssue(event.text);
          emit(`tool blocked: ${event.text}`);
        } else {
          emit(event.text);
        }
      }
    }
  }

  if (signal.aborted) {
    throw new Error("sub-agent aborted");
  }

  emit(`done (stopped after ${maxSubturns} subturns)`);
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant") as
    | AssistantMessage
    | undefined;

  const lastAssistantText = lastAssistant ? extractAssistantText(lastAssistant).trim() : "";
  const lastAssistantLine = lastAssistantText
    ? normalizeOneLine(lastAssistantText.split("\n")[0] ?? "")
    : "";
  const lastNote = lastAssistantLine ? ` Last output: "${lastAssistantLine}".` : "";

  throw new Error(
    `sub-agent stopped after ${maxSubturns} subturns without producing a final response.${lastNote}${formatIssueSummary()}`,
  );
}

async function consumeRunner(
  runner: AsyncGenerator<RunnerEvent, AssistantMessage, void>,
  onEvent: (event: RunnerEvent) => void,
): Promise<AssistantMessage> {
  while (true) {
    const next = await runner.next();
    if (next.done) {
      return next.value;
    }
    onEvent(next.value);
  }
}
