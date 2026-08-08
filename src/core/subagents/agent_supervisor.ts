import { randomUUID } from "node:crypto";
import { AgentRuntime, type AgentTurnResult, createAgentSpec } from "../agent/agent_runtime.js";
import type { AgentEvent } from "../agent/events.js";
import type { Config } from "../config/index.js";
import type { HistoryQuery } from "../history/types.js";
import { resolveAgentModel } from "../runtime/agent_model.js";
import { type CoreDeps, createDefaultCoreDeps } from "../runtime/deps.js";
import { createAutoCompactionArchiver } from "../session/auto_compaction_archive.js";
import { ToolCatalog } from "../tools/catalog.js";
import type { ToolExecutionBackend } from "../tools/execution_backend.js";
import type { ToolRunPresentation } from "../tools/presentation.js";
import type { Persona, ReasoningEffort } from "../types.js";
import {
  appendUsageLogEntry,
  getUsageCostTotal,
  getUsageTotals,
  type UsageRecorder,
} from "../usage/logs.js";
import { extractAssistantText } from "../utils/messages.js";
import { formatActiveSubagentsForCompaction } from "./format.js";
import type {
  SubagentCapacitySnapshot,
  SubagentEvent,
  SubagentName,
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
  name: SubagentName;
  title: string;
  model: {
    provider: string;
    id: string;
    reasoning: ReasoningEffort;
  };
  workingDirectory: string;
  createdAt: number;
  originHistoryEntryId: string;
  runtimeConfig: SubagentRuntimeConfig;
  personaId?: string;
  runtime: AgentRuntime;
  run: SubagentRunSnapshot;
  costTotal: number;
  usage: SubagentUsageSnapshot;
  toolPresentations: Map<string, ToolRunPresentation>;
  blockedToolCalls: Map<string, string>;
  completion: Promise<SubagentRecord>;
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
    const state = formatActiveSubagentsForCompaction(active);
    return `<active-subagents>\n${state}\n</active-subagents>`;
  }

  spawn(options: {
    runtimeConfig: SubagentRuntimeConfig;
    prompt: string;
    title: string;
    originHistoryEntryId: string;
    config: Config;
    backend: ToolExecutionBackend;
    history?: HistoryQuery;
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
    const persona: Persona = {
      id: `${options.personaId ?? "subagent"}-${runtimeConfig.name}`,
      label: runtimeConfig.name,
      description: runtimeConfig.description ?? "Background agent",
      source: "project",
      systemPrompt: runtimeConfig.systemPrompt,
      model: runtimeConfig.model,
      settings: runtimeConfig.settings,
      tools: runtimeConfig.tools,
      skills: [],
    };
    const runtime = new AgentRuntime({
      spec: createAgentSpec({
        ...resolveAgentModel(persona, options.config, {
          includeModelNotice: true,
          deps: this.deps,
        }),
        systemPrompt: runtimeConfig.systemPrompt,
        tools: ToolCatalog.createSubagentRegistry(
          runtimeConfig.tools,
          options.backend,
          workingDirectory,
          options.config,
          options.history,
        ),
      }),
      eventSink: async (event) => await this.recordAgentEvent(id, event),
      clock: this.deps.clock,
      archiveAutoCompaction: createAutoCompactionArchiver(options.backend),
    });
    const createdAt = this.deps.clock.now();
    const record: SubagentRecord = {
      id,
      name: runtimeConfig.name,
      title: options.title,
      model: {
        provider: runtimeConfig.model.provider,
        id: runtimeConfig.model.id,
        reasoning: runtime.spec.attribution.reasoningEffort,
      },
      workingDirectory,
      createdAt,
      originHistoryEntryId: options.originHistoryEntryId,
      runtimeConfig,
      personaId: options.personaId,
      runtime,
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
        contextWindow: runtimeConfig.model.contextWindow,
      },
      toolPresentations: new Map(),
      blockedToolCalls: new Map(),
      completion: Promise.resolve(undefined as never),
    };
    this.records.set(id, record);
    this.startRun(record, options.prompt, "subagent_spawned");
    return { ok: true, state: this.toSnapshot(record), capacity: this.getCapacity() };
  }

  sendInput(options: { id: string; prompt: string }): SubagentSendInputResult {
    const record = this.records.get(options.id);
    if (!record) return { ok: false, reason: `Unknown subagent ID: ${options.id}` };
    if (record.run.status === "running") {
      return {
        ok: false,
        reason: `Subagent ${options.id} is already running. Wait for it to finish before sending input.`,
      };
    }
    if (this.getActiveCount() >= MAX_ACTIVE_SUBAGENTS) {
      return {
        ok: false,
        reason: `Subagent limit reached (max ${MAX_ACTIVE_SUBAGENTS} active). Wait for existing agents to finish.`,
      };
    }

    record.run = {
      revision: record.run.revision + 1,
      status: "running",
      startedAt: this.deps.clock.now(),
      interruptRequested: false,
    };
    record.toolPresentations.clear();
    record.blockedToolCalls.clear();
    this.startRun(record, options.prompt, "subagent_run_started");
    return { ok: true, state: this.toSnapshot(record), capacity: this.getCapacity() };
  }

  async waitForAgents(ids: string[], signal?: AbortSignal): Promise<SubagentStateSnapshot[]> {
    const missing = ids.filter((id) => !this.records.has(id));
    if (missing.length > 0) throw new Error(`Unknown subagent ID(s): ${missing.join(", ")}`);
    await raceWithAbort(Promise.race(ids.map((id) => this.waitForRecord(id))), signal);
    return ids.map((id) => {
      const record = this.records.get(id);
      if (!record) throw new Error(`Unknown subagent ID: ${id}`);
      return this.toSnapshot(record);
    });
  }

  async interrupt(id: string, signal?: AbortSignal): Promise<SubagentStateSnapshot | undefined> {
    const record = this.records.get(id);
    if (!record) return undefined;
    if (record.run.status === "running") {
      record.run.interruptRequested = true;
      record.runtime.interrupt();
      await this.emit({ type: "subagent_interrupt_requested", state: this.toSnapshot(record) });
    }
    return this.toSnapshot(await raceWithAbort(this.waitForRecord(id), signal));
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
    record.completion = this.emit({ type: eventType, state: this.toSnapshot(record) })
      .then(async () => {
        if (record.run.interruptRequested) {
          return {
            aborted: true,
            terminalResult: { aborted: true },
          } satisfies AgentTurnResult;
        }
        return await record.runtime.submit(prompt);
      })
      .then((result) => {
        this.applyTurnResult(record, result);
        return record;
      })
      .catch((error) => {
        if (record.run.interruptRequested) {
          this.finishInterrupted(record);
        } else {
          this.finishFailed(record, {
            kind: "runtime-error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
        return record;
      })
      .then(async (resolved) => {
        if (this.records.get(resolved.id) === resolved) {
          await this.emit({ type: "subagent_finished", state: this.toSnapshot(resolved) });
        }
        return resolved;
      });
  }

  private applyTurnResult(record: SubagentRecord, result: AgentTurnResult): void {
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

    record.run = {
      revision: record.run.revision,
      status: "succeeded",
      startedAt: record.run.startedAt,
      finishedAt: this.deps.clock.now(),
      interruptRequested: false,
      response: extractAssistantText(result.finalMessage).trim(),
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
    record.run = {
      revision: record.run.revision,
      status: "failed",
      startedAt: record.run.startedAt,
      finishedAt: this.deps.clock.now(),
      interruptRequested: record.run.interruptRequested,
      failure,
    };
  }

  private async recordAgentEvent(id: string, event: AgentEvent): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;

    if (event.type === "assistant_final") {
      const usage = getUsageTotals(event.message.usage);
      const cost = getUsageCostTotal(event.message.usage);
      record.costTotal += cost;
      record.usage = {
        input: record.usage.input + usage.input,
        output: record.usage.output + usage.output,
        cacheRead: record.usage.cacheRead + usage.cacheRead,
        cacheWrite: record.usage.cacheWrite + usage.cacheWrite,
        contextWindowUsageTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
        contextWindow: record.runtimeConfig.model.contextWindow,
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
        agent: { type: "subagent", name: record.name },
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
    if (!record) throw new Error(`Unknown subagent ID: ${id}`);
    return await record.completion;
  }

  private toSnapshot(record: SubagentRecord): SubagentStateSnapshot {
    return {
      id: record.id,
      name: record.name,
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
