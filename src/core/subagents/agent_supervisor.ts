import { randomUUID } from "node:crypto";
import { AgentRuntime, type AgentSubturnResult, createAgentSpec } from "../agent/agent_runtime.js";
import type { AgentEvent } from "../agent/events.js";
import type { Config } from "../config/index.js";
import type { HistoryQuery } from "../history/types.js";
import type { McpManager } from "../mcp/manager.js";
import { resolveAgentModel } from "../runtime/agent_model.js";
import { type CoreDeps, createDefaultCoreDeps } from "../runtime/deps.js";
import { createAutoCompactionArchiver } from "../session/auto_compaction_archive.js";
import type { AgentJobRegistry, AgentJobs } from "../tools/agent_jobs.js";
import { ToolCatalog } from "../tools/catalog.js";
import type { ToolExecutionBackend } from "../tools/execution_backend.js";
import type { ToolRunPresentation } from "../tools/presentation.js";
import type { ReasoningEffort } from "../types.js";
import {
  appendUsageLogEntry,
  getUsageCostTotal,
  getUsageTotals,
  type UsageRecorder,
} from "../usage/logs.js";
import { extractAssistantText } from "../utils/messages.js";
import type { ClaudeCodeEvent, ClaudeCodeTokenUsage } from "./claude_code_protocol.js";
import { ClaudeCodeRuntime } from "./claude_code_runtime.js";
import { AgentRequestError } from "./errors.js";
import { formatActiveSubagentsForCompaction } from "./format.js";
import { AgentTrace, traceBlocks } from "./trace.js";
import type {
  SubagentCapacitySnapshot,
  SubagentConversationState,
  SubagentEvent,
  SubagentRunFailure,
  SubagentRunSnapshot,
  SubagentRuntimeConfig,
  SubagentStateSnapshot,
  SubagentUsageSnapshot,
} from "./types.js";

const MAX_ACTIVE_SUBAGENTS = 8;

export type SubagentSpawnResult =
  | { ok: true; state: SubagentStateSnapshot; capacity: SubagentCapacitySnapshot }
  | { ok: false; reason: string };

export type SubagentSendInputResult =
  | { ok: true; state: SubagentStateSnapshot; capacity: SubagentCapacitySnapshot }
  | { ok: false; reason: string };

type SubagentRecord = {
  id: string;
  title: string;
  model: {
    provider: string;
    id: string;
    reasoning: ReasoningEffort;
  };
  workingDirectory: string;
  createdAt: number;
  originHistoryEntryId: string;
  personaId?: string;
  runtime: AgentRuntime | ClaudeCodeRuntime;
  jobs: AgentJobs | null;
  run: SubagentRunSnapshot;
  costTotal: number;
  usage: SubagentUsageSnapshot;
  claudeMessageUsage: Map<string, ClaudeCodeTokenUsage | null>;
  toolPresentations: Map<string, ToolRunPresentation>;
  toolOutcomes: Map<string, "succeeded" | "failed" | "blocked" | "cancelled">;
  blockedToolCalls: Map<string, string>;
  completion: Promise<SubagentRecord>;
  trace: AgentTrace;
  pending: { prompt: string; mode: "queue" | "steer" }[];
  steering: number;
  steeringDelivery: Promise<void>;
  deliveryFailure?: Error;
};

async function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await promise;
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export class AgentSupervisor {
  private readonly records = new Map<string, SubagentRecord>();
  private readonly deps: CoreDeps;

  constructor(
    private readonly options: {
      onEvent: (event: SubagentEvent) => void | Promise<void>;
      recordUsage?: UsageRecorder;
      deps?: CoreDeps;
    },
  ) {
    this.deps = options.deps ?? createDefaultCoreDeps();
  }

  reset(): void {
    this.retainOrigins(new Set());
  }

  retainOrigins(originHistoryEntryIds: ReadonlySet<string>): void {
    for (const [id, record] of this.records) {
      if (originHistoryEntryIds.has(record.originHistoryEntryId)) continue;
      this.records.delete(id);
      record.runtime.dispose();
      record.jobs?.release();
    }
  }

  getCapacity(): SubagentCapacitySnapshot {
    return { running: this.getActiveCount(), limit: MAX_ACTIVE_SUBAGENTS };
  }

  getActiveCount(): number {
    return [...this.records.values()].filter((record) => record.run.status === "running").length;
  }

  getActiveCompactionContext(): string | undefined {
    const active = this.listSnapshots().filter((state) => state.availability === "running");
    if (active.length === 0) return undefined;
    const state = formatActiveSubagentsForCompaction(active.map((state) => this.read(state.id)));
    return `<active-subagents>\n${state}\n</active-subagents>`;
  }

  spawn(options: {
    runtimeConfig: SubagentRuntimeConfig;
    prompt: string;
    title: string;
    originHistoryEntryId: string;
    config: Config;
    backend: ToolExecutionBackend;
    jobs: AgentJobRegistry;
    history?: HistoryQuery;
    mcp?: McpManager;
    personaId?: string;
  }): SubagentSpawnResult {
    if (this.getActiveCount() >= MAX_ACTIVE_SUBAGENTS) {
      return {
        ok: false,
        reason: `Subagent limit reached (max ${MAX_ACTIVE_SUBAGENTS} active). Wait for existing agents to finish.`,
      };
    }

    const workingDirectory = options.runtimeConfig.workingDirectory.trim();
    if (!workingDirectory) {
      return { ok: false, reason: "Subagent workingDirectory must not be blank." };
    }

    const id = randomUUID();
    const runtimeConfig = { ...options.runtimeConfig, workingDirectory };
    let runtime: AgentRuntime | ClaudeCodeRuntime;
    let reasoning: ReasoningEffort;
    let jobs: AgentJobs | null = null;
    if (runtimeConfig.kind === "claude-code") {
      runtime = new ClaudeCodeRuntime({
        config: runtimeConfig,
        backend: options.backend,
        onEvent: async (event) => await this.recordClaudeCodeEvent(id, event),
      });
      reasoning = runtimeConfig.effort;
    } else {
      jobs = options.jobs.create();
      runtime = new AgentRuntime({
        agentId: id,
        spec: createAgentSpec({
          autoCompactThresholdTokens: null,
          ...resolveAgentModel(
            {
              id: `${options.personaId ?? "agent"}-subagent`,
              label: "subagent",
              description: "Background agent",
              source: "project",
              systemPrompt: runtimeConfig.systemPrompt,
              model: runtimeConfig.model,
              settings: runtimeConfig.settings,
              tools: runtimeConfig.tools,
              subagentLaunchModels: [],
            },
            options.config,
            {
              includeModelNotice: true,
              deps: this.deps,
            },
          ),
          systemPrompt: runtimeConfig.systemPrompt,
          tools: ToolCatalog.createSubagentRegistry(
            runtimeConfig.tools,
            options.backend,
            workingDirectory,
            options.config,
            jobs.bashJobs,
            jobs.codeJobs,
            options.history,
            options.mcp,
          ),
        }),
        eventSink: async (event) => await this.recordAgentEvent(id, event),
        clock: this.deps.clock,
        archiveAutoCompaction: createAutoCompactionArchiver(options.backend),
      });
      reasoning = runtime.spec.attribution.reasoningEffort;
    }
    const createdAt = this.deps.clock.now();
    const record: SubagentRecord = {
      id,
      title: options.title,
      model: {
        provider: runtimeConfig.model.provider,
        id: runtimeConfig.model.id,
        reasoning,
      },
      workingDirectory,
      createdAt,
      originHistoryEntryId: options.originHistoryEntryId,
      personaId: options.personaId,
      runtime,
      jobs,
      run: {
        revision: 1,
        status: "running",
        startedAt: createdAt,
        interruptRequested: false,
      },
      costTotal: 0,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        contextWindowUsageTokens: 0,
        contextWindow: runtimeConfig.kind === "native" ? runtimeConfig.model.contextWindow : 0,
      },
      claudeMessageUsage: new Map(),
      toolPresentations: new Map(),
      toolOutcomes: new Map(),
      blockedToolCalls: new Map(),
      completion: Promise.resolve(undefined as never),
      trace: new AgentTrace(),
      pending: [],
      steering: 0,
      steeringDelivery: Promise.resolve(),
    };
    this.records.set(id, record);
    record.trace.append({ kind: "input", mode: "initial", content: traceBlocks(options.prompt) });
    this.startRun(record, options.prompt, "subagent_spawned");
    return { ok: true, state: this.toSnapshot(record), capacity: this.getCapacity() };
  }

  sendInput(options: {
    id: string;
    prompt: string;
    mode: "queue" | "steer";
  }): SubagentSendInputResult {
    const record = this.records.get(options.id);
    if (!record) return { ok: false, reason: `Unknown subagent ID: ${options.id}` };
    if (record.run.interruptRequested && record.run.status === "running")
      return { ok: false, reason: "Subagent is stopping" };
    if (record.run.status !== "running" && this.getActiveCount() >= MAX_ACTIVE_SUBAGENTS)
      return { ok: false, reason: "Subagent capacity reached" };
    if (record.pending.length + record.steering >= 64)
      return { ok: false, reason: "Subagent input queue is full" };
    record.trace.append({
      kind: "input",
      mode: options.mode,
      content: traceBlocks(options.prompt),
    });
    if (record.run.status === "running") {
      record.pending.push({ prompt: options.prompt, mode: options.mode });
      this.deliverSteering(record);
    } else {
      this.beginFollowup(record, options.prompt);
    }
    return { ok: true, state: this.toSnapshot(record), capacity: this.getCapacity() };
  }

  private deliverSteering(record: SubagentRecord): void {
    if (record.run.interruptRequested) return;
    if (record.runtime instanceof ClaudeCodeRuntime) {
      const revision = record.run.revision;
      record.steeringDelivery = record.steeringDelivery.then(async () => {
        const runtime = record.runtime as ClaudeCodeRuntime;
        for (const input of [...record.pending]) {
          if (
            record.run.revision !== revision ||
            record.run.interruptRequested ||
            record.deliveryFailure
          )
            return;
          if (input.mode !== "steer") continue;
          try {
            if (!(await runtime.steer(input.prompt))) break;
          } catch (error) {
            if (record.run.revision !== revision || record.run.interruptRequested) return;
            record.deliveryFailure = error instanceof Error ? error : new Error(String(error));
            const index = record.pending.indexOf(input);
            if (index >= 0) record.pending.splice(index, 1);
            record.trace.append({
              kind: "notice",
              code: "input.discarded",
              content: traceBlocks(
                "Steering input discarded because delivery could not be confirmed.",
              ),
            });
            runtime.interrupt();
            return;
          }
          if (record.run.revision !== revision) return;
          const index = record.pending.indexOf(input);
          if (index >= 0) record.pending.splice(index, 1);
        }
      });
    } else if (record.runtime.status === "running") {
      for (const input of [...record.pending]) {
        if (input.mode !== "steer") continue;
        const submission = record.runtime.steer(input.prompt);
        record.pending.splice(record.pending.indexOf(input), 1);
        record.steering++;
        void submission.applied.then(
          () => {
            record.steering--;
          },
          () => {
            record.steering--;
            if (!record.run.interruptRequested) record.pending.unshift(input);
          },
        );
        void submission.result.catch(() => {});
      }
    }
  }

  private beginFollowup(record: SubagentRecord, prompt: string): void {
    record.run = {
      revision: record.run.revision + 1,
      status: "running",
      startedAt: this.deps.clock.now(),
      interruptRequested: false,
    };
    record.deliveryFailure = undefined;
    record.toolPresentations.clear();
    record.toolOutcomes.clear();
    record.blockedToolCalls.clear();
    this.startRun(record, prompt, "subagent_run_started");
  }

  read(id: string): SubagentConversationState {
    const record = this.records.get(id);
    if (!record) throw new AgentRequestError("unknown_agent", `Unknown subagent ID: ${id}`);
    const { run } = record;
    return {
      id,
      title: record.title,
      model: `${record.model.provider}/${record.model.id}:${record.model.reasoning}`,
      workingDirectory: record.workingDirectory,
      ...(run.status === "running"
        ? { status: run.interruptRequested ? "stopping" : "working" }
        : run.status === "failed"
          ? {
              status: "idle",
              reason: "failed",
              error: { code: run.failure.kind, message: run.failure.message },
            }
          : { status: "idle", reason: run.status === "succeeded" ? "completed" : "interrupted" }),
      pending: {
        queue: record.pending.filter((input) => input.mode === "queue").length,
        steer: record.steering + record.pending.filter((input) => input.mode === "steer").length,
      },
      usage: {
        input: record.usage.input,
        output: record.usage.output,
        cacheRead: record.usage.cacheRead,
        cacheWrite: record.usage.cacheWrite,
        contextTokens: record.usage.contextWindowUsageTokens,
        contextWindow: record.usage.contextWindow,
        cost: record.costTotal,
      },
    };
  }

  getTrace(id: string): AgentTrace {
    const record = this.records.get(id);
    if (!record) throw new AgentRequestError("unknown_agent", `Unknown subagent ID: ${id}`);
    return record.trace;
  }

  async waitForAgents(ids: string[], signal?: AbortSignal): Promise<SubagentStateSnapshot[]> {
    const missing = ids.filter((id) => !this.records.has(id));
    if (missing.length > 0)
      throw new AgentRequestError("unknown_agent", `Unknown subagent ID(s): ${missing.join(", ")}`);
    await raceWithAbort(Promise.race(ids.map((id) => this.waitForRecord(id))), signal);
    return ids.map((id) => {
      const record = this.records.get(id);
      if (!record) throw new AgentRequestError("unknown_agent", `Unknown subagent ID: ${id}`);
      return this.toSnapshot(record);
    });
  }

  async interrupt(
    id: string,
    signal?: AbortSignal,
    wait = true,
  ): Promise<SubagentStateSnapshot | undefined> {
    const record = this.records.get(id);
    if (!record) return undefined;
    if (record.run.status === "running") {
      if (record.pending.length || record.steering)
        record.trace.append({
          kind: "notice",
          code: "input.discarded",
          content: traceBlocks("Pending inputs discarded by interruption."),
        });
      record.pending = [];
      record.run.interruptRequested = true;
      record.trace.append({ kind: "status", status: "stopping" });
      record.runtime.interrupt();
      await this.emit({ type: "subagent_interrupt_requested", state: this.toSnapshot(record) });
    }
    return wait
      ? this.toSnapshot(await raceWithAbort(this.waitForRecord(id), signal))
      : this.toSnapshot(record);
  }

  getSnapshot(id: string): SubagentStateSnapshot | undefined {
    const record = this.records.get(id);
    return record ? this.toSnapshot(record) : undefined;
  }

  listSnapshots(): SubagentStateSnapshot[] {
    return [...this.records.values()].map((record) => this.toSnapshot(record));
  }

  private startRun(
    record: SubagentRecord,
    prompt: string,
    eventType: "subagent_spawned" | "subagent_run_started",
  ): void {
    record.trace.append({ kind: "status", status: "working" });
    record.completion = (async () => {
      try {
        await this.emit({ type: eventType, state: this.toSnapshot(record) });
        if (record.run.interruptRequested) {
          this.finishInterrupted(record);
        } else if (record.runtime instanceof ClaudeCodeRuntime) {
          const completion = await record.runtime.submit(prompt).finally(async () => {
            await record.steeringDelivery;
          });
          if (record.deliveryFailure) throw record.deliveryFailure;
          if (record.run.interruptRequested || completion.status === "interrupted") {
            this.finishInterrupted(record);
          } else if (completion.result.failed) {
            this.finishFailed(record, {
              kind: "provider-error",
              message: completion.result.response,
              stopReason: "error",
            });
          } else {
            this.finishSucceeded(record, completion.result.response);
          }
        } else {
          const result = await record.runtime.submit(prompt);
          this.applyTurnResult(record, result.terminalResult);
        }
      } catch (error) {
        if (record.run.interruptRequested) this.finishInterrupted(record);
        else
          this.finishFailed(record, {
            kind: "runtime-error",
            message: error instanceof Error ? error.message : String(error),
          });
      }
      if (this.records.get(record.id) === record) {
        const next = record.pending.shift();
        if (next && !record.run.interruptRequested) {
          this.beginFollowup(record, next.prompt);
          return await record.completion;
        }
        record.trace.append({
          kind: "status",
          status: "idle",
          reason:
            record.run.status === "succeeded"
              ? "completed"
              : record.run.status === "interrupted"
                ? "interrupted"
                : "failed",
        });
        await this.emit({ type: "subagent_finished", state: this.toSnapshot(record) });
      }
      return record;
    })();
  }

  private applyTurnResult(record: SubagentRecord, result: AgentSubturnResult): void {
    if (
      record.run.interruptRequested ||
      result.aborted ||
      result.finalMessage?.stopReason === "aborted"
    ) {
      this.finishInterrupted(record);
      return;
    }
    if (result.blocked) {
      this.finishFailed(record, {
        kind: result.blocked.reason,
        message: result.blocked.message,
      });
      return;
    }
    if (result.limitReached) {
      this.finishFailed(record, {
        kind: result.limitReached.reason,
        message: result.limitReached.message,
      });
      return;
    }
    if (!result.finalMessage) {
      this.finishFailed(record, {
        kind: "runtime-error",
        message: "Subagent run completed without a final assistant message.",
      });
      return;
    }
    if (result.finalMessage.stopReason === "error") {
      this.finishFailed(record, {
        kind: "provider-error",
        message: result.finalMessage.errorMessage ?? "model returned an unspecified error.",
        stopReason: result.finalMessage.stopReason,
      });
      return;
    }

    this.finishSucceeded(record, extractAssistantText(result.finalMessage).trim());
  }

  private finishSucceeded(record: SubagentRecord, response: string): void {
    record.run = {
      revision: record.run.revision,
      status: "succeeded",
      startedAt: record.run.startedAt,
      finishedAt: this.deps.clock.now(),
      interruptRequested: false,
      response,
    };
  }

  private finishInterrupted(record: SubagentRecord): void {
    record.run = {
      revision: record.run.revision,
      status: "interrupted",
      startedAt: record.run.startedAt,
      finishedAt: this.deps.clock.now(),
      interruptRequested: true,
      failure: { kind: "interrupted", message: "Subagent run was interrupted." },
    };
  }

  private finishFailed(
    record: SubagentRecord,
    failure: Exclude<SubagentRunFailure, { kind: "interrupted" }>,
  ): void {
    record.trace.append({
      kind: "notice",
      code: failure.kind,
      content: traceBlocks(failure.message),
    });
    record.run = {
      revision: record.run.revision,
      status: "failed",
      startedAt: record.run.startedAt,
      finishedAt: this.deps.clock.now(),
      interruptRequested: record.run.interruptRequested,
      failure,
    };
  }

  private async recordClaudeCodeEvent(id: string, event: ClaudeCodeEvent): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    if (event.type === "trace") record.trace.append(event.event);
    if (event.type === "control") this.deliverSteering(record);
    if (event.type === "unconsumed_input" && !record.run.interruptRequested)
      record.pending.push({ prompt: event.message, mode: "steer" });
    if (event.type === "usage" || event.type === "result") {
      let reported = event.usage;
      if (event.type === "usage") {
        const previous = record.claudeMessageUsage.get(event.messageId);
        // Final result totals already cover these messages, including resumed replays.
        if (previous === null) return;
        const current = {
          input: Math.max(previous?.input ?? 0, event.usage.input),
          output: Math.max(previous?.output ?? 0, event.usage.output),
          cacheRead: Math.max(previous?.cacheRead ?? 0, event.usage.cacheRead),
          cacheWrite: Math.max(previous?.cacheWrite ?? 0, event.usage.cacheWrite),
        };
        record.claudeMessageUsage.set(event.messageId, current);
        reported = {
          input: record.usage.input + current.input - (previous?.input ?? 0),
          output: record.usage.output + current.output - (previous?.output ?? 0),
          cacheRead: record.usage.cacheRead + current.cacheRead - (previous?.cacheRead ?? 0),
          cacheWrite: record.usage.cacheWrite + current.cacheWrite - (previous?.cacheWrite ?? 0),
        };
        if (getUsageTotals(current).total === getUsageTotals(previous).total) return;
        record.usage.contextWindowUsageTokens = getUsageTotals(current).total;
      } else {
        for (const messageId of record.claudeMessageUsage.keys()) {
          record.claudeMessageUsage.set(messageId, null);
        }
        record.usage.contextWindowUsageTokens = event.usage.contextWindowUsageTokens;
        record.usage.contextWindow = event.usage.contextWindow;
      }
      // SDK totals include the history restored on resume. Record only the delta,
      // and replace (rather than sum) the current context-window measurement.
      const usage = getUsageTotals({
        input: Math.max(0, reported.input - record.usage.input),
        output: Math.max(0, reported.output - record.usage.output),
        cacheRead: Math.max(0, reported.cacheRead - record.usage.cacheRead),
        cacheWrite: Math.max(0, reported.cacheWrite - record.usage.cacheWrite),
      });
      const cost = event.type === "result" ? Math.max(0, event.cost - record.costTotal) : 0;
      // Startup failures can report zero totals even for a resumed session.
      record.costTotal += cost;
      record.usage = {
        ...record.usage,
        input: record.usage.input + usage.input,
        output: record.usage.output + usage.output,
        cacheRead: record.usage.cacheRead + usage.cacheRead,
        cacheWrite: record.usage.cacheWrite + usage.cacheWrite,
      };
      (this.options.recordUsage ?? appendUsageLogEntry)({
        timestamp: this.deps.clock.now(),
        sessionId: record.id,
        personaId: record.personaId,
        provider: record.model.provider,
        model: record.model.id,
        api: "claude-agent-sdk",
        reasoningEffort: record.model.reasoning,
        usage,
        cost: { total: cost },
        agent: { type: "subagent" },
      });
      await this.emit({ type: "subagent_updated", state: this.toSnapshot(record) });
    } else if (event.type === "assistant") {
      await this.emit({
        type: "subagent_activity",
        state: this.toSnapshot(record),
        activity: { type: "assistant", text: event.text },
      });
    } else if (event.type === "tool") {
      await this.emit({
        type: "subagent_activity",
        state: this.toSnapshot(record),
        activity: {
          type: "tool",
          toolName: event.name,
          outcome: event.failed ? "failed" : "succeeded",
          presentation: {
            action: event.failed ? "failed" : "completed",
            subject: event.subject,
            subjectWrap: "word",
            details: [],
            metadata: [],
          },
        },
      });
    }
  }

  private async recordAgentEvent(id: string, event: AgentEvent): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;

    this.deliverSteering(record);
    if (event.type === "tool_call_admitted")
      record.trace.append({
        kind: "tool_call",
        callId: event.toolCall.id,
        toolName: event.toolCall.name,
        arguments: [{ type: "json", value: JSON.parse(JSON.stringify(event.toolCall.arguments)) }],
      });
    if (event.type === "tool_run_finished" || event.type === "tool_run_blocked")
      record.toolOutcomes.set(
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
      const outcome = record.toolOutcomes.get(message.toolCallId);
      if (!outcome) throw new Error(`Missing outcome for tool result ${message.toolCallId}`);
      record.trace.append({
        kind: "tool_result",
        callId: message.toolCallId,
        toolName: message.toolName,
        outcome,
        content: traceBlocks(message.content),
      });
      record.toolOutcomes.delete(message.toolCallId);
    }
    if (event.type === "compaction_end")
      record.trace.append({ kind: "notice", code: `compaction.${event.outcome}`, content: [] });
    if (event.type === "assistant_final") {
      const content = event.message.content.filter((block) => block.type === "text");
      if (content.length) record.trace.append({ kind: "assistant", content: traceBlocks(content) });
      const usage = getUsageTotals(event.message.usage);
      const cost = getUsageCostTotal(event.message.usage);
      record.costTotal += cost;
      record.usage = {
        input: record.usage.input + usage.input,
        output: record.usage.output + usage.output,
        cacheRead: record.usage.cacheRead + usage.cacheRead,
        cacheWrite: record.usage.cacheWrite + usage.cacheWrite,
        contextWindowUsageTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
        contextWindow: record.usage.contextWindow,
      };
      (this.options.recordUsage ?? appendUsageLogEntry)({
        timestamp: event.message.timestamp,
        sessionId: record.id,
        personaId: record.personaId ?? event.personaId,
        provider: event.message.provider,
        model: event.message.model,
        api: event.message.api,
        reasoningEffort: event.reasoningEffort,
        usage,
        cost: { total: cost },
        agent: { type: "subagent" },
      });
      await this.emit({ type: "subagent_updated", state: this.toSnapshot(record) });
      const text = extractAssistantText(event.message).trim();
      if (text) {
        await this.emit({
          type: "subagent_activity",
          state: this.toSnapshot(record),
          activity: { type: "assistant", text },
        });
      }
      return;
    }

    if (event.type === "tool_activity") {
      record.toolPresentations.set(event.activity.toolCallId, event.activity.presentation);
      const blockedToolName = record.blockedToolCalls.get(event.activity.toolCallId);
      if (blockedToolName) {
        record.blockedToolCalls.delete(event.activity.toolCallId);
        await this.emitSettledToolActivity(
          record,
          blockedToolName,
          "blocked",
          event.activity.presentation,
        );
        record.toolPresentations.delete(event.activity.toolCallId);
      }
      return;
    }

    if (event.type === "tool_run_blocked") {
      const presentation = record.toolPresentations.get(event.toolCallId);
      if (!presentation) {
        record.blockedToolCalls.set(event.toolCallId, event.toolName);
        return;
      }
      record.toolPresentations.delete(event.toolCallId);
      await this.emitSettledToolActivity(record, event.toolName, "blocked", presentation);
      return;
    }

    if (event.type === "tool_run_finished") {
      const presentation = record.toolPresentations.get(event.toolCallId);
      if (!presentation) {
        throw new Error(`missing presentation for settled tool call '${event.toolCallId}'`);
      }
      record.toolPresentations.delete(event.toolCallId);
      await this.emitSettledToolActivity(record, event.toolName, event.outcome, presentation);
      return;
    }

    if (event.type === "feedback") {
      await this.emit({
        type: "subagent_activity",
        state: this.toSnapshot(record),
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
    record: SubagentRecord,
    toolName: string,
    outcome: "succeeded" | "failed" | "blocked" | "cancelled",
    presentation: ToolRunPresentation,
  ): Promise<void> {
    const { actionByStatus, ...terminalPresentation } = presentation;
    await this.emit({
      type: "subagent_activity",
      state: this.toSnapshot(record),
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

  private async waitForRecord(id: string): Promise<SubagentRecord> {
    const record = this.records.get(id);
    if (!record) throw new AgentRequestError("unknown_agent", `Unknown subagent ID: ${id}`);
    do {
      await record.completion;
    } while (record.run.status === "running");
    return record;
  }

  private toSnapshot(record: SubagentRecord): SubagentStateSnapshot {
    return {
      id: record.id,
      title: record.title,
      availability: record.run.status === "running" ? "running" : "idle",
      model: { ...record.model },
      workingDirectory: record.workingDirectory,
      createdAt: record.createdAt,
      run: structuredClone(record.run),
      costTotal: record.costTotal,
      usage: { ...record.usage },
    };
  }

  private async emit(event: SubagentEvent): Promise<void> {
    await this.options.onEvent(event);
  }
}
