import { randomUUID } from "node:crypto";
import { AgentRuntime } from "../agent/agent_runtime.js";
import type { AgentsCapabilityOptions } from "../code_mode/agents.js";
import type { SessionRuntimeSettings } from "../config/index.js";
import type { OpenSubagentHistory } from "../history/agent_history_recorder.js";
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

const MAX_ACTIVE_SUBAGENTS = 16;

type SubagentRecord = {
  id: string;
  parentId: string;
  depth: number;
  launchEpoch: number;
  canDelegate: boolean;
  subtreeStops: number;
  kind: "delegated";
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
  lastAssistantSeq?: number;
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
  private readonly records = new Map<
    string,
    SubagentRecord | { kind: "main"; id: string; parentId: null; depth: 0; runtime: AgentRuntime }
  >();
  private readonly deps: CoreDeps;
  private mainLaunchEpoch = 0;
  private disposed = false;

  constructor(
    private readonly options: {
      mainAgentId: string;
      onEvent: (event: SubagentEvent) => void | Promise<void>;
      recordUsage?: UsageRecorder;
      openHistory?: OpenSubagentHistory;
      deps?: CoreDeps;
    },
  ) {
    this.deps = options.deps ?? createDefaultCoreDeps();
  }

  get mainAgentId(): string {
    return this.options.mainAgentId;
  }

  createMainRuntime(options: ConstructorParameters<typeof AgentRuntime>[0]): AgentRuntime {
    if (this.records.has(this.mainAgentId)) throw new Error("Main agent already registered");
    const runtime = new AgentRuntime({ ...options, agentId: this.mainAgentId });
    this.records.set(this.mainAgentId, {
      kind: "main",
      id: this.mainAgentId,
      parentId: null,
      depth: 0,
      runtime,
    });
    return runtime;
  }

  private delegatedRecords(): SubagentRecord[] {
    return [...this.records.values()].filter(
      (record): record is SubagentRecord => record.kind === "delegated",
    );
  }

  isDescendant(id: string, callerId: string): boolean {
    let record = this.records.get(id);
    while (record?.parentId) {
      if (record.parentId === callerId) return true;
      record = this.records.get(record.parentId);
    }
    return false;
  }

  scope(callerId: string): ScopedAgentSupervisor {
    return new ScopedAgentSupervisor(this, callerId);
  }

  prepareSpawn(callerId: string): number {
    if (this.disposed) throw new AgentRequestError("operation_failed", "Agent pool is disposed");
    if (callerId === this.mainAgentId) return this.mainLaunchEpoch;
    const parent = this.requireRecord(callerId);
    if (
      parent.depth >= 2 ||
      !parent.canDelegate ||
      parent.subtreeStops > 0 ||
      parent.run.interruptRequested
    )
      throw new AgentRequestError("operation_failed", "Agent cannot delegate");
    return parent.launchEpoch;
  }

  dispose(): void {
    this.disposed = true;
    this.reset();
    this.records.get(this.mainAgentId)?.runtime.dispose();
    this.records.delete(this.mainAgentId);
  }

  reset(): void {
    this.retainOrigins(new Set());
  }

  retainOrigins(originHistoryEntryIds: ReadonlySet<string>): void {
    this.mainLaunchEpoch++;
    for (const record of this.delegatedRecords()) {
      const id = record.id;
      if (originHistoryEntryIds.has(record.originHistoryEntryId)) continue;
      this.records.delete(id);
      record.runtime.dispose();
    }
  }

  getCapacity(): SubagentCapacitySnapshot {
    return { running: this.getActiveCount(), limit: MAX_ACTIVE_SUBAGENTS };
  }

  getActiveCount(): number {
    return this.delegatedRecords().filter((record) => record.run.status === "running").length;
  }

  getActiveCompactionContext(callerId: string): string | undefined {
    const active = this.scope(callerId)
      .list()
      .filter((state) => state.status !== "idle");
    if (active.length === 0) return undefined;
    const state = formatActiveSubagentsForCompaction(active);
    return `<active-subagents>\n${state}\n</active-subagents>`;
  }

  spawn(options: {
    parentId: string;
    launchEpoch: number;
    agents?: AgentsCapabilityOptions;
    runtimeConfig: SubagentRuntimeConfig;
    prompt: string;
    title: string;
    originHistoryEntryId: string;
    config: SessionRuntimeSettings;
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

    const parentId = options.parentId;
    const epoch = this.prepareSpawn(parentId);
    if (options.launchEpoch !== epoch)
      throw new AgentRequestError("operation_failed", "Delegation was interrupted");
    const parent = parentId === this.mainAgentId ? undefined : this.requireRecord(parentId);
    const depth = (parent?.depth ?? 0) + 1;
    const workingDirectory = options.runtimeConfig.workingDirectory.trim();
    if (!workingDirectory) {
      throw new AgentRequestError(
        "invalid_arguments",
        "Subagent workingDirectory must not be blank.",
      );
    }

    const id = randomUUID();
    const runtimeConfig = {
      ...options.runtimeConfig,
      workingDirectory,
      tools: options.runtimeConfig.tools.filter(
        (tool) => tool !== "agents" || (depth < 2 && options.runtimeConfig.kind === "native"),
      ),
    };
    const createdAt = this.deps.clock.now();
    const openHistory = this.options.openHistory;
    const runtime = createSubagentRuntime(runtimeConfig, {
      ...options,
      id,
      parentId,
      supervisor: this,
      agents: options.agents,
      deps: this.deps,
      openHistory: openHistory
        ? () =>
            openHistory({ sessionId: id, parentSessionId: parentId, workingDirectory, createdAt })
        : undefined,
      onEvent: async (event) => await this.recordRuntimeEvent(id, event),
    });
    const record: SubagentRecord = {
      id,
      parentId,
      depth,
      launchEpoch: 0,
      canDelegate: runtimeConfig.kind === "native" && runtimeConfig.tools.includes("agents"),
      subtreeStops: 0,
      kind: "delegated",
      title: options.title,
      model: runtime.model,
      workingDirectory,
      createdAt,
      originHistoryEntryId: parent?.originHistoryEntryId ?? options.originHistoryEntryId,
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
    if (
      record.subtreeStops > 0 ||
      (record.run.interruptRequested && record.run.status === "running")
    )
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
    record.lastAssistantSeq = undefined;
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
      parentId: record.parentId,
      depth: record.depth,
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
    scope: "agent" | "subtree" = "agent",
  ): Promise<SubagentConversationState> {
    const record = this.requireRecord(id);
    if (scope === "subtree") {
      const targets = this.delegatedRecords().filter(
        (target) => target.id === id || this.isDescendant(target.id, id),
      );
      for (const target of targets) {
        target.launchEpoch++;
        target.subtreeStops++;
      }
      const stopping = Promise.allSettled(
        targets.map(async (target) => {
          try {
            await this.interrupt(target.id, undefined, false);
          } finally {
            await this.waitForRecord(target.id);
          }
        }),
      )
        .then((results) => {
          const failure = results.find((result) => result.status === "rejected");
          if (failure?.status === "rejected") throw failure.reason;
        })
        .finally(() => {
          for (const target of targets) target.subtreeStops--;
        });
      if (wait) await raceWithAbort(stopping, signal);
      else void stopping.catch(() => {});
      return this.read(id);
    }
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

  getLastResponse(id: string): { seq: number; text: string; complete: boolean } | undefined {
    const record = this.requireRecord(id);
    const seq = record.lastAssistantSeq;
    if (record.run.status === "running" || seq === undefined) return undefined;
    try {
      return { seq, ...record.trace.readText(seq, Number.POSITIVE_INFINITY) };
    } catch (error) {
      if (!(error instanceof AgentRequestError) || error.code !== "expired_content") throw error;
      return { seq, text: "", complete: false };
    }
  }

  getSnapshot(id: string): SubagentStateSnapshot | undefined {
    const record = this.records.get(id);
    return record?.kind === "delegated" ? this.toSnapshot(record) : undefined;
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
        if (this.records.get(record.id) !== record || record.run.interruptRequested) {
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
    if (record?.kind !== "delegated") return;
    if (event.type === "trace") {
      const seq = record.trace.append(event.event);
      if (event.event.kind === "assistant") record.lastAssistantSeq = seq;
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
    if (record?.kind !== "delegated")
      throw new AgentRequestError("unknown_agent", `Unknown subagent ID: ${id}`);
    return record;
  }

  list(): SubagentConversationState[] {
    return this.delegatedRecords().map((record) => this.read(record.id));
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
      parentId: record.parentId,
      depth: record.depth,
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

export class ScopedAgentSupervisor {
  constructor(
    private readonly supervisor: AgentSupervisor,
    readonly callerId: string,
  ) {}
  private check(id: string): void {
    if (!this.supervisor.isDescendant(id, this.callerId))
      throw new AgentRequestError("unknown_agent", `Unknown subagent ID: ${id}`);
  }
  prepareSpawn(): number {
    return this.supervisor.prepareSpawn(this.callerId);
  }
  spawn(options: Omit<Parameters<AgentSupervisor["spawn"]>[0], "parentId">) {
    return this.supervisor.spawn({ ...options, parentId: this.callerId });
  }
  list() {
    return this.supervisor
      .list()
      .filter((state) => this.supervisor.isDescendant(state.id, this.callerId));
  }
  getCapacity() {
    return this.supervisor.getCapacity();
  }
  read(id: string) {
    this.check(id);
    return this.supervisor.read(id);
  }
  sendInput(options: Parameters<AgentSupervisor["sendInput"]>[0]) {
    this.check(options.id);
    return this.supervisor.sendInput(options);
  }
  interrupt(id: string, signal?: AbortSignal, wait = true, scope: "agent" | "subtree" = "agent") {
    this.check(id);
    return this.supervisor.interrupt(id, signal, wait, scope);
  }
  waitForAgents(ids: string[], signal?: AbortSignal) {
    for (const id of ids) this.check(id);
    return this.supervisor.waitForAgents(ids, signal);
  }
  getTrace(id: string) {
    this.check(id);
    return this.supervisor.getTrace(id);
  }
  getSnapshot(id: string) {
    this.check(id);
    return this.supervisor.getSnapshot(id);
  }
  getLastResponse(id: string) {
    this.check(id);
    return this.supervisor.getLastResponse(id);
  }
}
