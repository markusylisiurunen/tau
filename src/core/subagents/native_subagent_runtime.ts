import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { AgentRuntime, type AgentSubturnResult, createAgentSpec } from "../agent/agent_runtime.js";
import type { AgentEvent } from "../agent/events.js";
import { resolveAgentModel } from "../runtime/agent_model.js";
import { createAutoCompactionArchiver } from "../session/auto_compaction_archive.js";
import type { AgentJobs } from "../tools/agent_jobs.js";
import { ToolCatalog } from "../tools/catalog.js";
import type { ToolRunPresentation } from "../tools/presentation.js";
import { getUsageCostTotal, getUsageTotals } from "../usage/logs.js";
import { extractAssistantText } from "../utils/messages.js";
import { runtimeFailure } from "./errors.js";
import type { ContentBlock, ObservableEvent } from "./events.js";
import type {
  SubagentRuntime,
  SubagentRuntimeOptions,
  SubagentRuntimeOutcome,
  SubagentRuntimeSettlement,
} from "./runtime.js";
import type { NativeSubagentConfig } from "./types.js";

function nativeContent(content: (TextContent | ImageContent)[]): ContentBlock[] {
  return content.map((block) =>
    block.type === "text"
      ? { type: "text", text: block.text }
      : { type: "image", data: block.data, mimeType: block.mimeType },
  );
}

export class NativeSubagentRuntime implements SubagentRuntime {
  private readonly agent: AgentRuntime;
  private readonly jobs: AgentJobs;
  private readonly toolPresentations = new Map<string, ToolRunPresentation>();
  private readonly toolOutcomes = new Map<
    string,
    "succeeded" | "failed" | "blocked" | "cancelled"
  >();
  private readonly blockedToolCalls = new Map<string, string>();
  private steering: { prompt: string; submitted: boolean }[] = [];
  private readonly deliveries = new Set<Promise<void>>();
  private interrupted = false;

  constructor(
    private readonly config: NativeSubagentConfig,
    private readonly options: SubagentRuntimeOptions,
  ) {
    this.jobs = options.jobs.create();
    this.agent = new AgentRuntime({
      agentId: options.id,
      spec: createAgentSpec({
        autoCompactThresholdTokens: null,
        ...resolveAgentModel(
          {
            id: `${options.personaId ?? "agent"}-subagent`,
            label: "subagent",
            description: "Background agent",
            source: "project",
            systemPrompt: config.systemPrompt,
            model: config.model,
            settings: config.settings,
            tools: config.tools,
            subagentLaunchModels: [],
          },
          options.config,
          {
            includeModelNotice: true,
            deps: options.deps,
          },
        ),
        systemPrompt: config.systemPrompt,
        tools: ToolCatalog.createSubagentRegistry(
          config.tools,
          options.backend,
          config.workingDirectory,
          options.config,
          this.jobs.bashJobs,
          this.jobs.codeJobs,
          options.history,
          options.mcp,
        ),
      }),
      eventSink: async (event) => await this.recordEvent(event),
      clock: options.deps.clock,
      archiveAutoCompaction: createAutoCompactionArchiver(options.backend),
    });
  }

  get model() {
    const { model } = this.config;
    return {
      provider: model.provider,
      id: model.id,
      reasoning: this.agent.spec.attribution.reasoningEffort,
    };
  }

  get contextWindow(): number {
    return this.config.model.contextWindow;
  }
  get pendingSteering(): number {
    return this.steering.length;
  }

  steer(prompt: string): void {
    this.steering.push({ prompt, submitted: false });
    this.deliverSteering();
  }

  private deliverSteering(): void {
    if (this.interrupted || this.agent.status !== "running") return;
    for (const input of this.steering) {
      if (input.submitted) continue;
      const submission = this.agent.steer(input.prompt);
      input.submitted = true;
      const delivery = submission.applied
        .then(
          () => {
            const index = this.steering.indexOf(input);
            if (index >= 0) this.steering.splice(index, 1);
          },
          () => {}, // Unapplied input is returned with settlement.
        )
        .finally(() => this.deliveries.delete(delivery));
      this.deliveries.add(delivery);
      void submission.result.catch(() => {});
    }
  }

  async submit(prompt: string): Promise<SubagentRuntimeSettlement> {
    this.interrupted = false;
    this.toolPresentations.clear();
    this.toolOutcomes.clear();
    this.blockedToolCalls.clear();
    let outcome: SubagentRuntimeOutcome;
    try {
      const result = await this.agent.submit(prompt);
      outcome = this.turnOutcome(result.terminalResult);
    } catch (error) {
      outcome = runtimeFailure(error);
    } finally {
      await Promise.all(this.deliveries);
    }
    const unconsumed = this.interrupted ? [] : this.steering.map((input) => input.prompt);
    this.steering = [];
    return { outcome: this.interrupted ? { status: "interrupted" } : outcome, unconsumed };
  }

  interrupt(): void {
    this.interrupted = true;
    this.steering = [];
    this.agent.interrupt();
  }

  dispose(): void {
    this.interrupt();
    this.agent.dispose();
    this.jobs.release();
  }

  private turnOutcome(result: AgentSubturnResult): SubagentRuntimeOutcome {
    if (result.aborted || result.finalMessage?.stopReason === "aborted")
      return { status: "interrupted" };
    if (result.blocked)
      return {
        status: "failed",
        failure: { kind: result.blocked.reason, message: result.blocked.message },
      };
    if (result.limitReached)
      return {
        status: "failed",
        failure: { kind: result.limitReached.reason, message: result.limitReached.message },
      };
    if (!result.finalMessage)
      return runtimeFailure(new Error("Subagent run completed without a final assistant message."));
    if (result.finalMessage.stopReason === "error")
      return {
        status: "failed",
        failure: {
          kind: "provider-error",
          message: result.finalMessage.errorMessage ?? "model returned an unspecified error.",
          stopReason: result.finalMessage.stopReason,
        },
      };
    return { status: "succeeded", response: extractAssistantText(result.finalMessage).trim() };
  }

  private async trace(event: ObservableEvent): Promise<void> {
    await this.options.onEvent({ type: "trace", event });
  }

  private async recordEvent(event: AgentEvent): Promise<void> {
    this.deliverSteering();
    if (event.type === "tool_call_admitted")
      await this.trace({
        kind: "tool_call",
        callId: event.toolCall.id,
        toolName: event.toolCall.name,
        arguments: [{ type: "json", value: JSON.parse(JSON.stringify(event.toolCall.arguments)) }],
      });
    if (event.type === "tool_run_finished" || event.type === "tool_run_blocked")
      this.toolOutcomes.set(
        event.toolCallId,
        event.type === "tool_run_blocked" ? "blocked" : event.outcome,
      );
    const results =
      event.type === "tool_result"
        ? [event.message]
        : event.type === "tool_recovery"
          ? event.toolResults
          : [];
    for (const message of results) {
      const outcome = this.toolOutcomes.get(message.toolCallId);
      if (!outcome) throw new Error(`Missing outcome for tool result ${message.toolCallId}`);
      await this.trace({
        kind: "tool_result",
        callId: message.toolCallId,
        toolName: message.toolName,
        outcome,
        content: nativeContent(message.content),
      });
      this.toolOutcomes.delete(message.toolCallId);
    }
    if (event.type === "compaction_end")
      await this.trace({ kind: "notice", code: `compaction.${event.outcome}`, content: [] });
    if (event.type === "assistant_final") {
      const content = event.message.content.filter((block) => block.type === "text");
      if (content.length) await this.trace({ kind: "assistant", content: nativeContent(content) });
      const usage = getUsageTotals(event.message.usage);
      const cost = getUsageCostTotal(event.message.usage);
      await this.options.onEvent({
        type: "usage",
        entry: {
          timestamp: event.message.timestamp,
          personaId: event.personaId,
          provider: event.message.provider,
          model: event.message.model,
          api: event.message.api,
          reasoningEffort: event.reasoningEffort,
          usage,
          cost: { total: cost },
        },
        contextTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
        contextWindow: this.contextWindow,
      });
      const text = extractAssistantText(event.message).trim();
      if (text) {
        await this.options.onEvent({
          type: "activity",
          activity: { type: "assistant", text },
        });
      }
      return;
    }

    if (event.type === "tool_activity") {
      this.toolPresentations.set(event.activity.toolCallId, event.activity.presentation);
      const blockedToolName = this.blockedToolCalls.get(event.activity.toolCallId);
      if (blockedToolName) {
        this.blockedToolCalls.delete(event.activity.toolCallId);
        await this.emitSettledToolActivity(blockedToolName, "blocked", event.activity.presentation);
        this.toolPresentations.delete(event.activity.toolCallId);
      }
      return;
    }

    if (event.type === "tool_run_blocked") {
      const presentation = this.toolPresentations.get(event.toolCallId);
      if (!presentation) {
        this.blockedToolCalls.set(event.toolCallId, event.toolName);
        return;
      }
      this.toolPresentations.delete(event.toolCallId);
      await this.emitSettledToolActivity(event.toolName, "blocked", presentation);
      return;
    }

    if (event.type === "tool_run_finished") {
      const presentation = this.toolPresentations.get(event.toolCallId);
      if (!presentation) {
        throw new Error(`missing presentation for settled tool call '${event.toolCallId}'`);
      }
      this.toolPresentations.delete(event.toolCallId);
      await this.emitSettledToolActivity(event.toolName, event.outcome, presentation);
      return;
    }

    if (event.type === "feedback") {
      await this.options.onEvent({
        type: "activity",
        activity: {
          type: "notice",
          severity: event.tone === "error" ? "error" : "info",
          title: event.title,
          ...(event.presentation === "transcript" && event.content
            ? { content: event.content }
            : {}),
        },
      });
    }
  }

  private async emitSettledToolActivity(
    toolName: string,
    outcome: "succeeded" | "failed" | "blocked" | "cancelled",
    presentation: ToolRunPresentation,
  ): Promise<void> {
    const { actionByStatus, ...terminalPresentation } = presentation;
    await this.options.onEvent({
      type: "activity",
      activity: {
        type: "tool",
        toolName,
        outcome,
        presentation: {
          action: actionByStatus[outcome],
          ...structuredClone(terminalPresentation),
        },
      },
    });
  }
}
