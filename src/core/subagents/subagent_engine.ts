import { randomUUID } from "node:crypto";
import type { AssistantMessage, Context, Message, ToolCall } from "@mariozechner/pi-ai";
import { formatCodexAuthError } from "../auth/auth_messages.js";
import { getAuthPath } from "../auth/auth_paths.js";
import { AuthStorage } from "../auth/auth_storage.js";
import { type CredentialResolver, createCredentialResolver } from "../auth/credential_resolver.js";
import type { Config } from "../config/index.js";
import type { ModelResolver } from "../models/catalog.js";
import { type RunnerEvent, runModelSubturn, runToolCalls } from "../session/runner.js";
import { ToolCatalog } from "../tools/catalog.js";
import type { ToolExecutionBackend } from "../tools/execution_backend.js";
import {
  createLocalToolExecutionBackend,
  scopeToolExecutionBackend,
} from "../tools/execution_backend.js";
import type {
  SubagentDispatchContext,
  ToolDispatchContext,
  ToolRegistry,
  ToolUiEvent,
} from "../tools/registry.js";
import type { RiskLevel } from "../types.js";
import { appendUsageLogEntry, getUsageCostTotal, getUsageTotals } from "../usage/logs.js";
import { shouldAutoRetry } from "../utils/auto_retry.js";
import { CODEX_ORIGINATOR, CODEX_USER_AGENT } from "../utils/codex.js";
import { extractAssistantText } from "../utils/messages.js";
import { prependModelNotice, resolveModelNotice } from "../utils/model_notices.js";
import type { TauStreamOptions } from "../utils/streaming_settings.js";
import { parseStreamingSettings } from "../utils/streaming_settings.js";
import {
  extractAssistantTextForProgress,
  formatToolUiEventForProgress,
  getToolResultFirstLine,
  normalizeOneLine,
} from "../utils/subagent_utils.js";
import { createTokenCounter } from "../utils/token_counting.js";
import type { SubagentRuntimeConfig, SubagentToolName, SubagentUsageSnapshot } from "./types.js";

export type SubagentProgressEvent = {
  text: string;
  costTotal: number;
  turns: number;
  toolCalls: number;
  usage: SubagentUsageSnapshot;
};

export type SubagentToolUiEvent = {
  uiEvent: ToolUiEvent;
  costTotal: number;
  turns: number;
  toolCalls: number;
  usage: SubagentUsageSnapshot;
};

export type SubagentRunResult = {
  finalText: string;
  costTotal: number;
  turns: number;
  toolCalls: number;
};

const MAX_SUBAGENT_SUBTURNS = 128;

function getStreamingSettings(settings: SubagentRuntimeConfig["settings"]): TauStreamOptions {
  const merged = { ...(settings ?? {}) } as Record<string, unknown>;
  return parseStreamingSettings(merged);
}

function buildToolRegistryForAllowedTools(
  allowedTools: SubagentToolName[],
  config: Config,
  backend: ToolExecutionBackend,
): ToolRegistry {
  return ToolCatalog.createSubagentRegistry(allowedTools, config, backend);
}

function isToolCall(block: AssistantMessage["content"][number]): block is ToolCall {
  return block.type === "toolCall";
}

export async function runSubagent(options: {
  runtimeConfig: SubagentRuntimeConfig;
  prompt: string;
  config: Config;
  authPath?: string;
  backend?: ToolExecutionBackend;
  messages?: Message[];
  signal: AbortSignal;
  onProgress?: (event: SubagentProgressEvent) => void;
  onToolUiEvent?: (event: SubagentToolUiEvent) => void;
  sessionId?: string;
  personaId?: string;
  turnUserHistoryEntryId: string;
  subagentContext: SubagentDispatchContext;
  modelResolver: ModelResolver;
}): Promise<SubagentRunResult> {
  const {
    runtimeConfig,
    prompt,
    config,
    signal,
    onProgress,
    onToolUiEvent,
    subagentContext,
    personaId,
    turnUserHistoryEntryId,
    modelResolver,
  } = options;
  const authPath = options.authPath ?? getAuthPath();
  const authStorage = new AuthStorage(authPath);
  const credentialResolver: CredentialResolver = createCredentialResolver({
    authStorage,
    getConfig: () => config,
  });

  if (signal.aborted) {
    throw new Error("sub-agent aborted");
  }

  const sessionId = options.sessionId ?? `tau-subagent-${runtimeConfig.name}-${randomUUID()}`;
  const tokenCounter = createTokenCounter({
    method: config.tokenCounting,
    getAnthropicApiKey: () => credentialResolver.getApiKey("anthropic", { sessionId }),
  });

  const baseBackend = options.backend ?? createLocalToolExecutionBackend();
  const backend = scopeToolExecutionBackend(baseBackend, runtimeConfig.workingDirectory);
  const allowedTools = runtimeConfig.tools;
  const toolRegistry = buildToolRegistryForAllowedTools(allowedTools, config, backend);
  const messages = options.messages ?? [];
  const promptWithModelNotice = prependModelNotice(
    prompt,
    resolveModelNotice(config, runtimeConfig.model),
  );
  messages.push({
    role: "user",
    content: [{ type: "text", text: promptWithModelNotice }],
    timestamp: Date.now(),
  });

  let costTotal = 0;
  let turns = 0;
  let toolCalls = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let contextWindowUsageTokens = 0;
  const maxSubturns = MAX_SUBAGENT_SUBTURNS;

  const getUsageSnapshot = (): SubagentUsageSnapshot => ({
    input,
    output,
    cacheRead,
    cacheWrite,
    contextWindowUsageTokens,
    contextWindow: runtimeConfig.model.contextWindow,
  });

  const emitProgress = (text: string) => {
    onProgress?.({ text, costTotal, turns, toolCalls, usage: getUsageSnapshot() });
  };

  const emitToolUi = (uiEvent: ToolUiEvent) => {
    onToolUiEvent?.({ uiEvent, costTotal, turns, toolCalls, usage: getUsageSnapshot() });
  };

  const issues: string[] = [];

  const recordIssue = (text: string) => {
    const normalized = normalizeOneLine(text);
    if (!normalized) return;
    issues.push(normalized);
  };

  const formatIssueSummary = (): string =>
    issues.length > 0 ? ` (Recent issues: ${issues.slice(-3).join("; ")})` : "";

  for (let subturn = 1; subturn <= maxSubturns && !signal.aborted; subturn++) {
    emitProgress("assistant: thinking");

    const context: Context = {
      systemPrompt: runtimeConfig.systemPrompt,
      messages,
      tools: toolRegistry.schemas,
    };

    let apiKey: string | undefined;
    try {
      apiKey = await credentialResolver.getApiKey(runtimeConfig.model.provider, { sessionId });
    } catch (error) {
      if (runtimeConfig.model.provider === "openai-codex") {
        throw new Error(formatCodexAuthError(authPath, (error as Error)?.message));
      }
      throw error;
    }

    if (!apiKey && runtimeConfig.model.provider === "openai-codex") {
      throw new Error(formatCodexAuthError(authPath));
    }
    const baseOptions: TauStreamOptions = {
      ...getStreamingSettings(runtimeConfig.settings),
      signal,
      sessionId,
      ...(apiKey && { apiKey }),
    };

    if (runtimeConfig.model.provider === "openai-codex") {
      baseOptions.headers = {
        ...baseOptions.headers,
        originator: CODEX_ORIGINATOR,
        "User-Agent": CODEX_USER_AGENT,
      };
    }

    const runner = runModelSubturn({
      model: runtimeConfig.model,
      context,
      streamOptions: baseOptions,
      signal,
      emitPartials: false,
      retry: {
        shouldRetryAfterError: ({ error, model }) => shouldAutoRetry({ model, error }),
        maxRetries: 1,
        delayMs: 3000,
        notice: { text: "auto-retrying after transient error", severity: "warn" },
      },
    });

    let finalMessage: AssistantMessage;
    try {
      finalMessage = await consumeRunner(runner, (event) => {
        if (event.type === "notice") {
          emitProgress(event.text);
        }
      });
    } catch (err) {
      if (!signal.aborted) {
        try {
          await credentialResolver.noteProviderError?.(runtimeConfig.model.provider, {
            sessionId,
            error: err,
          });
        } catch {}
      }
      if (signal.aborted) {
        throw new Error("sub-agent aborted");
      }
      throw err;
    }

    messages.push(finalMessage);
    const usageTotals = getUsageTotals(finalMessage.usage);
    appendUsageLogEntry({
      timestamp: finalMessage.timestamp,
      sessionId,
      personaId,
      provider: finalMessage.provider,
      model: finalMessage.model,
      api: finalMessage.api,
      reasoningEffort: runtimeConfig.settings?.reasoning ?? "none",
      usage: usageTotals,
      cost: { total: getUsageCostTotal(finalMessage.usage) },
      agent: { type: "subagent", name: runtimeConfig.name },
    });
    turns++;
    costTotal += getUsageCostTotal(finalMessage.usage);
    input += usageTotals.input;
    output += usageTotals.output;
    cacheRead += usageTotals.cacheRead;
    cacheWrite += usageTotals.cacheWrite;
    contextWindowUsageTokens =
      usageTotals.input + usageTotals.cacheRead + usageTotals.cacheWrite + usageTotals.output;

    const messageToolCalls = finalMessage.content.filter(isToolCall);
    toolCalls += messageToolCalls.length;

    // Emit any assistant text output
    const agentText = extractAssistantTextForProgress(finalMessage);
    if (agentText) {
      emitProgress(agentText);
    }

    const finish = () => {
      const finalText = extractAssistantText(finalMessage).trim();
      if (!finalText) {
        throw new Error(
          `Sub-agent produced an empty response (stopReason: ${finalMessage.stopReason ?? "unknown"})${formatIssueSummary()}`,
        );
      }
      emitProgress("done");
      return { finalText, costTotal, turns, toolCalls };
    };

    if (finalMessage.stopReason !== "toolUse") {
      return finish();
    }

    if (messageToolCalls.length === 0) {
      return finish();
    }

    const riskLevel = runtimeConfig.riskLevel as RiskLevel;

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
      if (text && /\b(blocked|failed):/.test(text)) {
        recordIssue(text);
      }

      emitToolUi(uiEvent);
    };

    const dispatchContext: ToolDispatchContext = {
      scope: "subagent",
      config,
      toolRegistry,
      authPath,
      tokenCounter,
      turnUserHistoryEntryId,
      cwd: runtimeConfig.workingDirectory,
      modelResolver,
      subagentContext,
    };

    const toolRunner = runToolCalls({
      toolCalls: messageToolCalls,
      toolRegistry,
      enabledTools: toolRegistry.getEnabledToolSchemas(),
      riskLevel,
      signal,
      dispatchContext,
      toolErrorMessages: {
        notEnabled: (toolCall) => `Tool '${toolCall.name}' is not available to this sub-agent.`,
        unsupported: (toolCall) => `Tool '${toolCall.name}' is not available to this sub-agent.`,
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
            : `${event.message.toolName}: Tool returned an error.`;
          recordIssue(issue);
        }
        continue;
      }

      if (event.type === "notice") {
        if (event.severity === "error") {
          recordIssue(event.text);
          emitProgress(`tool blocked: ${event.text}`);
        } else {
          emitProgress(event.text);
        }
      }
    }
  }

  if (signal.aborted) {
    throw new Error("sub-agent aborted");
  }

  emitProgress(`done (stopped after ${maxSubturns} subturns)`);
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant") as
    | AssistantMessage
    | undefined;

  const lastAssistantText = lastAssistant ? extractAssistantText(lastAssistant).trim() : "";
  const lastAssistantLine = lastAssistantText
    ? normalizeOneLine(lastAssistantText.split("\n")[0] ?? "")
    : "";
  const lastNote = lastAssistantLine ? ` Last output: "${lastAssistantLine}".` : "";

  throw new Error(
    `Sub-agent stopped after ${maxSubturns} subturns without producing a final response.${lastNote}${formatIssueSummary()}`,
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
