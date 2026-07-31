import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AgentRuntime, createAgentSpec } from "../agent/agent_runtime.js";
import type { AgentEvent } from "../agent/events.js";
import type { Config } from "../config/index.js";
import type { CoreDeps } from "../runtime/deps.js";
import { ToolCatalog } from "../tools/catalog.js";
import type { ToolExecutionBackend } from "../tools/execution_backend.js";
import type { Persona } from "../types.js";
import {
  appendUsageLogEntry,
  getUsageCostTotal,
  getUsageTotals,
  type UsageRecorder,
} from "../usage/logs.js";
import { extractAssistantText } from "../utils/messages.js";
import {
  extractAssistantTextForProgress,
  formatToolUiEventForProgress,
  getToolResultFirstLine,
} from "../utils/subagent_utils.js";
import type {
  SubagentName,
  SubagentRuntimeConfig,
  SubagentStateSnapshot,
  SubagentStatus,
  SubagentUiEvent,
  SubagentUsageSnapshot,
} from "./types.js";

const MAX_ACTIVE_SUBAGENTS = 8;

export type SubagentResult = {
  id: string;
  name: SubagentName;
  title: string;
  status: SubagentStatus;
  costTotal: number;
  turns: number;
  toolCalls: number;
  finalText?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
};

export type SubagentSpawnResult = { ok: true; id: string } | { ok: false; reason: string };

export type SubagentSendInputResult =
  | { ok: true; id: string; name: SubagentName; title: string }
  | { ok: false; reason: string };

type SubagentRecord = {
  id: string;
  name: SubagentName;
  title: string;
  modelLabel?: string;
  originHistoryEntryId: string;
  runtimeConfig: SubagentRuntimeConfig;
  config: Config;
  backend: ToolExecutionBackend;
  personaId?: string;
  runtime: AgentRuntime;
  status: SubagentStatus;
  costTotal: number;
  turns: number;
  toolCalls: number;
  usage: SubagentUsageSnapshot;
  startedAt: number;
  finishedAt?: number;
  abortRequested: boolean;
  finalText?: string;
  error?: string;
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

  constructor(
    private readonly options: {
      onEvent: (event: SubagentUiEvent) => void | Promise<void>;
      recordUsage?: UsageRecorder;
      deps?: CoreDeps;
    },
  ) {}

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

  getActiveCount(): number {
    return [...this.records.values()].filter((record) => record.status === "running").length;
  }

  spawn(options: {
    runtimeConfig: SubagentRuntimeConfig;
    prompt: string;
    title: string;
    modelLabel?: string;
    originHistoryEntryId: string;
    config: Config;
    backend: ToolExecutionBackend;
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
      settings: runtimeConfig.settings ?? {},
      tools: runtimeConfig.tools,
      skills: [],
    };
    const runtime = new AgentRuntime({
      spec: createAgentSpec({
        persona,
        systemPrompt: runtimeConfig.systemPrompt,
        tools: ToolCatalog.createSubagentRegistry(
          runtimeConfig.tools,
          options.backend,
          workingDirectory,
          options.config,
        ),
        config: options.config,
      }),
      eventSink: async (event) => await this.recordAgentEvent(id, event),
      ...(this.options.deps ? { deps: this.options.deps } : {}),
    });
    const record: SubagentRecord = {
      id,
      name: runtimeConfig.name,
      title: options.title,
      modelLabel: options.modelLabel,
      originHistoryEntryId: options.originHistoryEntryId,
      runtimeConfig,
      config: options.config,
      backend: options.backend,
      personaId: options.personaId,
      runtime,
      status: "running",
      costTotal: 0,
      turns: 0,
      toolCalls: 0,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        contextWindowUsageTokens: 0,
        contextWindow: runtimeConfig.model.contextWindow,
      },
      startedAt: Date.now(),
      abortRequested: false,
      completion: Promise.resolve(undefined as never),
    };
    this.records.set(id, record);
    this.startRun(record, options.prompt);
    return { ok: true, id };
  }

  sendInput(options: { id: string; prompt: string }): SubagentSendInputResult {
    const record = this.records.get(options.id);
    if (!record) return { ok: false, reason: `Unknown subagent ID: ${options.id}` };
    if (record.status === "running") {
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
    this.startRun(record, options.prompt);
    return { ok: true, id: record.id, name: record.name, title: record.title };
  }

  async waitForAgents(ids: string[], signal?: AbortSignal): Promise<SubagentResult[]> {
    const missing = ids.filter((id) => !this.records.has(id));
    if (missing.length > 0) throw new Error(`Unknown subagent ID(s): ${missing.join(", ")}`);
    const completed = this.getCompletedRecords(ids);
    if (completed.length > 0) return completed.map((record) => this.toResult(record));
    await raceWithAbort(Promise.race(ids.map((id) => this.waitForRecord(id))), signal);
    return this.getCompletedRecords(ids).map((record) => this.toResult(record));
  }

  async terminate(id: string, signal?: AbortSignal): Promise<SubagentResult | undefined> {
    const record = this.records.get(id);
    if (!record) return undefined;
    if (record.status === "running") {
      record.abortRequested = true;
      await this.emit({ type: "subagent_abort_requested", id });
      record.runtime.interrupt();
    }
    return this.toResult(await raceWithAbort(this.waitForRecord(id), signal));
  }

  getSnapshot(id: string): SubagentStateSnapshot | undefined {
    const record = this.records.get(id);
    return record ? this.toSnapshot(record) : undefined;
  }

  listSnapshots(): SubagentStateSnapshot[] {
    return [...this.records.values()].map((record) => this.toSnapshot(record));
  }

  private startRun(record: SubagentRecord, prompt: string): void {
    record.status = "running";
    record.startedAt = Date.now();
    record.finishedAt = undefined;
    record.abortRequested = false;
    record.error = undefined;
    record.finalText = undefined;
    record.completion = this.emit({ type: "subagent_spawned", state: this.toSnapshot(record) })
      .then(async () => await record.runtime.submit(prompt))
      .then((result) => {
        if (result.aborted) throw new Error("subagent was interrupted");
        if (result.blocked) throw new Error(result.blocked.message);
        const assistant = [...record.runtime.rawHistory]
          .reverse()
          .find((message): message is AssistantMessage => message.role === "assistant");
        const finalText = assistant ? extractAssistantText(assistant).trim() : "";
        if (!finalText) throw new Error("Sub-agent produced an empty response.");
        record.status = "success";
        record.finalText = finalText;
        return record;
      })
      .catch((error) => {
        const aborted = record.abortRequested;
        record.status = aborted ? "aborted" : "error";
        record.error = aborted ? undefined : error instanceof Error ? error.message : String(error);
        return record;
      })
      .then(async (resolved) => {
        resolved.finishedAt = Date.now();
        if (this.records.get(resolved.id) === resolved) {
          await this.emit({ type: "subagent_finished", state: this.toSnapshot(resolved) });
        }
        return resolved;
      });
  }

  private async recordAgentEvent(id: string, event: AgentEvent): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    let text = "";
    switch (event.type) {
      case "assistant_final": {
        const usage = getUsageTotals(event.message.usage);
        const cost = getUsageCostTotal(event.message.usage);
        record.turns += 1;
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
          personaId: event.personaId,
          provider: event.message.provider,
          model: event.message.model,
          api: event.message.api,
          reasoningEffort: event.reasoningEffort,
          usage,
          cost: { total: cost },
          agent: { type: "subagent", name: record.name },
        });
        text = extractAssistantTextForProgress(event.message) ?? "";
        break;
      }
      case "tool_call_admitted":
        record.toolCalls += 1;
        return;
      case "tool_ui":
        text = formatToolUiEventForProgress(event.uiEvent) ?? "";
        break;
      case "tool_result":
        if (event.message.isError) {
          const firstLine = getToolResultFirstLine(event.message);
          text = firstLine
            ? `${event.message.toolName}: ${firstLine}`
            : `${event.message.toolName}: tool returned an error`;
        }
        break;
      case "turn_started":
        text = "assistant: thinking";
        break;
      case "turn_finished":
        if (event.outcome === "completed") text = "done";
        break;
      case "notice":
        text = event.text;
        break;
      default:
        return;
    }
    await this.emit({
      type: "subagent_progress",
      id,
      text,
      costTotal: record.costTotal,
      turns: record.turns,
      toolCalls: record.toolCalls,
      usage: { ...record.usage },
    });
  }

  private getCompletedRecords(ids: string[]): SubagentRecord[] {
    return ids
      .map((id) => this.records.get(id))
      .filter(
        (record): record is SubagentRecord => record !== undefined && record.status !== "running",
      );
  }

  private async waitForRecord(id: string): Promise<SubagentRecord> {
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown subagent ID: ${id}`);
    return record.status === "running" ? await record.completion : record;
  }

  private toSnapshot(record: SubagentRecord): SubagentStateSnapshot {
    return {
      id: record.id,
      name: record.name,
      title: record.title,
      modelLabel: record.modelLabel,
      status: record.status,
      costTotal: record.costTotal,
      turns: record.turns,
      toolCalls: record.toolCalls,
      usage: { ...record.usage },
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      abortRequested: record.abortRequested,
      error: record.error,
      finalText: record.finalText,
    };
  }

  private toResult(record: SubagentRecord): SubagentResult {
    const { usage: _usage, runtime: _runtime, completion: _completion, ...result } = record;
    return {
      id: result.id,
      name: result.name,
      title: result.title,
      status: result.status,
      costTotal: result.costTotal,
      turns: result.turns,
      toolCalls: result.toolCalls,
      finalText: result.finalText,
      error: result.error,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
    };
  }

  private async emit(event: SubagentUiEvent): Promise<void> {
    await this.options.onEvent(event);
  }
}
