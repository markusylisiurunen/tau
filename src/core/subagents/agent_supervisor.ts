import { randomUUID } from "node:crypto";
import type { Config } from "../config/index.js";
import type { HistoryQuery } from "../history/types.js";
import type { McpManager } from "../mcp/manager.js";
import { type CoreDeps, createDefaultCoreDeps } from "../runtime/deps.js";
import type { AgentJobRegistry } from "../tools/agent_jobs.js";
import type { ToolExecutionBackend } from "../tools/execution_backend.js";
import { appendUsageLogEntry, type UsageRecorder } from "../usage/logs.js";
import { AgentRequestError } from "./errors.js";
import type { SubagentRuntimeEvent } from "./events.js";
import { formatActiveSubagentsForCompaction } from "./format.js";
import { createSubagentRuntime, type SubagentRuntime } from "./runtime.js";
import { AgentTrace } from "./trace.js";
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

type SubagentRecord = {
  id: string;
  title: string;
  model: SubagentStateSnapshot["model"];
  workingDirectory: string;
  createdAt: number;
  originHistoryEntryId: string;
  personaId?: string;
  runtime: SubagentRuntime;
  run: SubagentRunSnapshot;
  costTotal: number;
  usage: SubagentUsageSnapshot;
  completion: Promise<void>;
  trace: AgentTrace;
  pending: { prompt: string; mode: "queue" | "steer" }[];
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
    const active = this.list().filter((state) => state.status !== "idle");
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
    jobs: AgentJobRegistry;
    history?: HistoryQuery;
    mcp?: McpManager;
    personaId?: string;
  }): SubagentConversationState {
    if (this.getActiveCount() >= MAX_ACTIVE_SUBAGENTS) {
      throw new AgentRequestError(
        "operation_failed",
        `Subagent limit reached (max ${MAX_ACTIVE_SUBAGENTS} active). Wait for existing agents to finish.`,
      );
    }

    const workingDirectory = options.runtimeConfig.workingDirectory.trim();
    if (!workingDirectory) {
      throw new AgentRequestError(
        "invalid_arguments",
        "Subagent workingDirectory must not be blank.",
      );
    }

    const id = randomUUID();
    const runtimeConfig = { ...options.runtimeConfig, workingDirectory };
    const runtime = createSubagentRuntime(runtimeConfig, {
      ...options,
      id,
      deps: this.deps,
      onEvent: async (event) => await this.recordRuntimeEvent(id, event),
    });
    const createdAt = this.deps.clock.now();
    const record: SubagentRecord = {
      id,
      title: options.title,
      model: runtime.model,
      workingDirectory,
      createdAt,
      originHistoryEntryId: options.originHistoryEntryId,
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
        contextWindow: runtime.contextWindow,
      },
      completion: Promise.resolve(),
      trace: new AgentTrace(),
      pending: [],
    };
    this.records.set(id, record);
    record.trace.append({
      kind: "input",
      mode: "initial",
      content: [{ type: "text", text: options.prompt }],
    });
    this.startRun(record, options.prompt, "subagent_spawned");
    return this.read(record.id);
  }

  sendInput(options: {
    id: string;
    prompt: string;
    mode: "queue" | "steer";
  }): SubagentConversationState {
    const record = this.requireRecord(options.id);
    if (record.run.interruptRequested && record.run.status === "running")
      throw new AgentRequestError("operation_failed", "Subagent is stopping");
    if (record.run.status !== "running" && this.getActiveCount() >= MAX_ACTIVE_SUBAGENTS)
      throw new AgentRequestError("operation_failed", "Subagent capacity reached");
    if (record.pending.length + record.runtime.pendingSteering >= 64)
      throw new AgentRequestError("operation_failed", "Subagent input queue is full");
    record.trace.append({
      kind: "input",
      mode: options.mode,
      content: [{ type: "text", text: options.prompt }],
    });
    if (record.run.status === "running") {
      if (options.mode === "steer") record.runtime.steer(options.prompt);
      else record.pending.push({ prompt: options.prompt, mode: options.mode });
    } else {
      this.beginFollowup(record, options.prompt);
    }
    return this.read(record.id);
  }

  private beginFollowup(record: SubagentRecord, prompt: string): void {
    record.run = {
      revision: record.run.revision + 1,
      status: "running",
      startedAt: this.deps.clock.now(),
      interruptRequested: false,
    };
    this.startRun(record, prompt, "subagent_run_started");
  }

  read(id: string): SubagentConversationState {
    const record = this.requireRecord(id);
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
        steer:
          record.runtime.pendingSteering +
          record.pending.filter((input) => input.mode === "steer").length,
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
    const record = this.requireRecord(id);
    return record.trace;
  }

  async waitForAgents(ids: string[], signal?: AbortSignal): Promise<SubagentConversationState[]> {
    const missing = ids.filter((id) => !this.records.has(id));
    if (missing.length > 0)
      throw new AgentRequestError("unknown_agent", `Unknown subagent ID(s): ${missing.join(", ")}`);
    await raceWithAbort(Promise.race(ids.map((id) => this.waitForRecord(id))), signal);
    return ids.map((id) => this.read(id));
  }

  async interrupt(
    id: string,
    signal?: AbortSignal,
    wait = true,
  ): Promise<SubagentConversationState> {
    const record = this.requireRecord(id);
    if (record.run.status === "running") {
      if (record.pending.length || record.runtime.pendingSteering)
        record.trace.append({
          kind: "notice",
          code: "input.discarded",
          content: [{ type: "text", text: "Pending inputs discarded by interruption." }],
        });
      record.pending = [];
      record.run.interruptRequested = true;
      record.trace.append({ kind: "status", status: "stopping" });
      record.runtime.interrupt();
      await this.emit({ type: "subagent_interrupt_requested", state: this.toSnapshot(record) });
    }
    if (wait) await raceWithAbort(this.waitForRecord(id), signal);
    return this.read(id);
  }

  getSnapshot(id: string): SubagentStateSnapshot | undefined {
    const record = this.records.get(id);
    return record ? this.toSnapshot(record) : undefined;
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
        } else {
          const { outcome, unconsumed } = await record.runtime.submit(prompt);
          if (record.run.interruptRequested || outcome.status === "interrupted") {
            this.finishInterrupted(record);
          } else {
            record.pending.push(
              ...unconsumed.map((prompt) => ({ prompt, mode: "steer" as const })),
            );
            if (outcome.status === "failed") this.finishFailed(record, outcome.failure);
            else this.finishSucceeded(record, outcome.response);
          }
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
    })();
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
      content: [{ type: "text", text: failure.message }],
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

  private async recordRuntimeEvent(id: string, event: SubagentRuntimeEvent): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    if (event.type === "trace") {
      record.trace.append(event.event);
    } else if (event.type === "activity") {
      await this.emit({
        type: "subagent_activity",
        state: this.toSnapshot(record),
        activity: event.activity,
      });
    } else {
      const { usage, cost } = event.entry;
      record.costTotal += cost.total;
      record.usage = {
        input: record.usage.input + usage.input,
        output: record.usage.output + usage.output,
        cacheRead: record.usage.cacheRead + usage.cacheRead,
        cacheWrite: record.usage.cacheWrite + usage.cacheWrite,
        contextWindowUsageTokens: event.contextTokens,
        contextWindow: event.contextWindow,
      };
      (this.options.recordUsage ?? appendUsageLogEntry)({
        ...event.entry,
        sessionId: record.id,
        personaId: record.personaId ?? event.entry.personaId,
        agent: { type: "subagent" },
      });
      await this.emit({ type: "subagent_updated", state: this.toSnapshot(record) });
    }
  }

  private requireRecord(id: string): SubagentRecord {
    const record = this.records.get(id);
    if (!record) throw new AgentRequestError("unknown_agent", `Unknown subagent ID: ${id}`);
    return record;
  }

  list(): SubagentConversationState[] {
    return [...this.records.keys()].map((id) => this.read(id));
  }

  private async waitForRecord(id: string): Promise<SubagentRecord> {
    const record = this.requireRecord(id);
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
