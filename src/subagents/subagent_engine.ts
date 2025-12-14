import type {
  AssistantMessage,
  Context,
  KnownProvider,
  Message,
  SimpleStreamOptions,
  ToolCall,
} from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import type { Config } from "../config.js";
import { getApiKeyForProvider } from "../config.js";
import { createBashToolDefinition } from "../tools/bash.js";
import type {
  ToolDefinition,
  ToolDispatchResult,
  ToolDispatchResultWithPhases,
  ToolUiEvent,
} from "../tools/registry.js";
import { ToolRegistry } from "../tools/registry.js";
import type { RiskLevel } from "../types.js";
import { createToolError, extractAssistantText } from "../utils/messages.js";
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

function getStreamingSettings(settings: SubagentPersonaConfig["settings"]): SimpleStreamOptions {
  const merged = { ...(settings ?? {}) } as Record<string, unknown>;
  const reasoning = merged.reasoning;

  if (reasoning === undefined || reasoning === "none") {
    delete merged.reasoning;
  }

  return merged as unknown as SimpleStreamOptions;
}

function buildToolRegistryForAllowedTools(allowedTools: AllowedSubagentToolName[]): ToolRegistry {
  const definitions: ToolDefinition[] = [];

  for (const tool of allowedTools) {
    switch (tool) {
      case "bash":
        definitions.push(createBashToolDefinition());
        break;
    }
  }

  return new ToolRegistry(definitions);
}

function formatToolUiEventForProgress(uiEvent: ToolUiEvent): string | undefined {
  switch (uiEvent.type) {
    case "bash_started":
      return `bash running: ${uiEvent.command.replace(/\n/g, " ")}`;
    default:
      return undefined;
  }
}

function extractAssistantTextForProgress(message: AssistantMessage): string | undefined {
  const text = extractAssistantText(message).trim();
  const firstLine = text.split("\n")[0];
  return firstLine ? `agent: ${firstLine}` : undefined;
}

function isToolCall(block: AssistantMessage["content"][number]): block is ToolCall {
  return block.type === "toolCall";
}

function isPhased(
  result: ToolDispatchResult | ToolDispatchResultWithPhases,
): result is ToolDispatchResultWithPhases {
  return result.kind === "phased";
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

  const toolRegistry = buildToolRegistryForAllowedTools(definition.allowedTools);
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

  for (let subturn = 1; subturn <= maxSubturns && !signal.aborted; subturn++) {
    emit("assistant: thinking");

    const context: Context = {
      systemPrompt: definition.systemPrompt,
      messages,
      tools: toolRegistry.schemas,
    };

    const apiKey = getApiKeyForProvider(config, personaConfig.model.provider as KnownProvider);
    const stream = streamSimple(personaConfig.model, context, {
      ...getStreamingSettings(personaConfig.settings),
      signal,
      ...(apiKey && { apiKey }),
    });

    let finalMessage: AssistantMessage;
    try {
      for await (const _event of stream) {
        if (signal.aborted) break;
      }
      finalMessage = await stream.result();
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

    if (finalMessage.stopReason !== "toolUse") {
      emit("done");
      return { finalText: extractAssistantText(finalMessage).trim(), costTotal };
    }

    if (messageToolCalls.length === 0) {
      emit("done");
      return { finalText: extractAssistantText(finalMessage).trim(), costTotal };
    }

    const riskLevel = definition.riskLevel as RiskLevel;

    for (const call of messageToolCalls) {
      if (signal.aborted) break;

      const toolDef = toolRegistry.get(call.name);
      if (!toolDef) {
        const msg = `tool '${call.name}' is not available to this sub-agent.`;
        messages.push(createToolError(call, msg));
        emit(`tool blocked: ${msg}`);
        continue;
      }

      const dispatchResult = await toolDef.dispatch(call, riskLevel, signal);

      const handleUi = (uiEvent: ToolUiEvent | undefined) => {
        if (!uiEvent) return;
        const text = formatToolUiEventForProgress(uiEvent);
        if (text) emit(text);
      };

      if (isPhased(dispatchResult)) {
        handleUi(dispatchResult.startedUiEvent);

        if (dispatchResult.uiEvents) {
          for await (const uiEvent of dispatchResult.uiEvents) {
            if (signal.aborted) break;
            handleUi(uiEvent);
          }
        }

        const { toolResult, uiEvent } = await dispatchResult.run;
        messages.push(toolResult);
        handleUi(uiEvent);
        continue;
      }

      messages.push(dispatchResult.toolResult);
      handleUi(dispatchResult.uiEvent);
    }
  }

  emit(`done (stopped after ${maxSubturns} subturns)`);
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant") as
    | AssistantMessage
    | undefined;

  return { finalText: lastAssistant ? extractAssistantText(lastAssistant).trim() : "", costTotal };
}
