import { randomUUID } from "node:crypto";
import { cleanupSessionResources, type Message } from "@earendil-works/pi-ai";
import type { Config } from "../config/index.js";
import type { ModelResolver } from "../models/catalog.js";
import type { ToolExecutionBackend } from "../tools/execution_backend.js";
import type { SubagentDispatchContext } from "../tools/registry.js";
import { formatToolUiEventForProgress } from "../utils/subagent_utils.js";
import type { SubagentProgressEvent, SubagentToolUiEvent } from "./subagent_engine.js";
import { runSubagent } from "./subagent_engine.js";
import type {
  SubagentName,
  SubagentRuntimeConfig,
  SubagentStateSnapshot,
  SubagentStatus,
  SubagentUiEvent,
  SubagentUsageSnapshot,
} from "./types.js";

const MAX_ACTIVE_SUBAGENTS = 8;
const MAX_PROGRESS_EVENTS = 200;

export type SubagentResult = {
  id: string;
  name: SubagentName;
  title: string;
  status: SubagentStatus;
  costTotal: number;
  turns: number;
  toolCalls: number;
  outputs: string[];
  finalText?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
};

export type SubagentSpawnResult = { ok: true; id: string } | { ok: false; reason: string };

export type SubagentSendInputResult =
  | { ok: true; id: string; name: SubagentName; title: string }
  | { ok: false; reason: string };

type SubagentLogEntry = {
  kind: "progress" | "output";
  text: string;
};

type SubagentRecord = {
  id: string;
  name: SubagentName;
  title: string;
  modelLabel?: string;
  originHistoryEntryId: string;
  runtimeConfig: SubagentRuntimeConfig;
  modelResolver: ModelResolver;
  messages: Message[];
  status: SubagentStatus;
  costTotal: number;
  turns: number;
  toolCalls: number;
  usage: SubagentUsageSnapshot;
  costOffset: number;
  turnsOffset: number;
  toolCallsOffset: number;
  inputOffset: number;
  outputOffset: number;
  cacheReadOffset: number;
  cacheWriteOffset: number;
  startedAt: number;
  finishedAt?: number;
  abortRequested: boolean;
  progress: SubagentLogEntry[];
  outputs: string[];
  finalText?: string;
  error?: string;
  controller: AbortController;
  completion: Promise<SubagentRecord>;
};

async function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return await promise;
  }

  if (signal.aborted) {
    throw new Error("aborted");
  }

  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new Error("aborted"));
    };

    signal.addEventListener("abort", onAbort);

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

export class SubagentControlPlane {
  private readonly records = new Map<string, SubagentRecord>();
  private readonly onEvent: (event: SubagentUiEvent) => void;

  constructor(options: { onEvent: (event: SubagentUiEvent) => void }) {
    this.onEvent = options.onEvent;
  }

  reset(): void {
    this.retainOrigins(new Set());
  }

  retainOrigins(originHistoryEntryIds: ReadonlySet<string>): void {
    for (const [id, record] of this.records) {
      if (originHistoryEntryIds.has(record.originHistoryEntryId)) {
        continue;
      }
      this.records.delete(id);
      cleanupSessionResources(record.id);
      if (record.status === "running") {
        record.abortRequested = true;
        record.controller.abort();
      }
    }
  }

  getActiveCount(): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.status === "running") {
        count += 1;
      }
    }
    return count;
  }

  spawn(options: {
    runtimeConfig: SubagentRuntimeConfig;
    prompt: string;
    title: string;
    modelLabel?: string;
    originHistoryEntryId: string;
    config: Config;
    modelResolver: ModelResolver;
    authPath?: string;
    backend: ToolExecutionBackend;
    personaId?: string;
  }): SubagentSpawnResult {
    if (this.getActiveCount() >= MAX_ACTIVE_SUBAGENTS) {
      return {
        ok: false,
        reason:
          `Subagent limit reached (max ${MAX_ACTIVE_SUBAGENTS} active). ` +
          "Wait for existing agents to finish.",
      };
    }

    const {
      runtimeConfig,
      prompt,
      title,
      modelLabel,
      originHistoryEntryId,
      config,
      modelResolver,
      authPath,
      backend,
      personaId,
    } = options;

    const workingDirectory = runtimeConfig.workingDirectory.trim();
    if (!workingDirectory) {
      return {
        ok: false,
        reason: "Subagent workingDirectory must not be blank.",
      };
    }

    const normalizedRuntimeConfig = {
      ...runtimeConfig,
      workingDirectory,
    };

    const id = randomUUID();

    const record: SubagentRecord = {
      id,
      name: normalizedRuntimeConfig.name,
      title,
      modelLabel,
      originHistoryEntryId,
      runtimeConfig: normalizedRuntimeConfig,
      modelResolver,
      messages: [],
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
        contextWindow: normalizedRuntimeConfig.model?.contextWindow ?? 0,
      },
      costOffset: 0,
      turnsOffset: 0,
      toolCallsOffset: 0,
      inputOffset: 0,
      outputOffset: 0,
      cacheReadOffset: 0,
      cacheWriteOffset: 0,
      startedAt: Date.now(),
      abortRequested: false,
      progress: [],
      outputs: [],
      controller: new AbortController(),
      completion: Promise.resolve(undefined as never),
    };

    this.records.set(id, record);
    this.startRun({ record, prompt, config, authPath, backend, personaId });

    return { ok: true, id };
  }

  sendInput(options: {
    id: string;
    prompt: string;
    config: Config;
    modelResolver: ModelResolver;
    authPath?: string;
    backend: ToolExecutionBackend;
    personaId?: string;
  }): SubagentSendInputResult {
    const { id, prompt, config, modelResolver, authPath, backend, personaId } = options;
    const record = this.records.get(id);
    if (!record) {
      return { ok: false, reason: `Unknown subagent ID: ${id}` };
    }

    if (record.status === "running") {
      return {
        ok: false,
        reason: `Subagent ${id} is already running. Wait for it to finish before sending input.`,
      };
    }

    if (this.getActiveCount() >= MAX_ACTIVE_SUBAGENTS) {
      return {
        ok: false,
        reason:
          `Subagent limit reached (max ${MAX_ACTIVE_SUBAGENTS} active). ` +
          "Wait for existing agents to finish.",
      };
    }

    record.modelResolver = modelResolver;
    this.startRun({ record, prompt, config, authPath, backend, personaId });

    return { ok: true, id: record.id, name: record.name, title: record.title };
  }

  recordEmitOutput(id: string, text: string): void {
    const record = this.records.get(id);
    if (!record) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const payload = text.trimEnd();
    record.outputs.push(payload);
    this.emit({ type: "subagent_emit_output", id, text: payload });
  }

  async waitForAgents(ids: string[], signal?: AbortSignal): Promise<SubagentResult[]> {
    const missing = ids.filter((id) => !this.records.has(id));
    if (missing.length > 0) {
      throw new Error(`Unknown subagent ID(s): ${missing.join(", ")}`);
    }

    const completed = this.getCompletedRecords(ids);
    if (completed.length > 0) {
      return completed.map((record) => this.toResult(record));
    }

    const completions = ids.map((id) => this.waitForRecord(id));
    await raceWithAbort(Promise.race(completions), signal);
    return this.getCompletedRecords(ids).map((record) => this.toResult(record));
  }

  async terminate(id: string, signal?: AbortSignal): Promise<SubagentResult | undefined> {
    const record = this.records.get(id);
    if (!record) return undefined;

    const aborting = record.status === "running";
    if (aborting) {
      if (!record.abortRequested) {
        record.abortRequested = true;
        this.emit({ type: "subagent_abort_requested", id });
      }
      record.controller.abort();
    }

    const completion = this.waitForRecord(id);
    const resolved = await raceWithAbort(completion, signal);
    if (aborting) {
      cleanupSessionResources(record.id);
    }
    return this.toResult(resolved);
  }

  getSnapshot(id: string): SubagentStateSnapshot | undefined {
    const record = this.records.get(id);
    return record ? this.toSnapshot(record) : undefined;
  }

  listSnapshots(): SubagentStateSnapshot[] {
    return [...this.records.values()].map((record) => this.toSnapshot(record));
  }

  getOriginHistoryEntryId(id: string): string {
    const record = this.records.get(id);
    if (!record) {
      throw new Error(`Unknown subagent ID: ${id}`);
    }
    return record.originHistoryEntryId;
  }

  private startRun(options: {
    record: SubagentRecord;
    prompt: string;
    config: Config;
    authPath?: string;
    backend: ToolExecutionBackend;
    personaId?: string;
  }): void {
    const { record, prompt, config, authPath, backend, personaId } = options;

    record.status = "running";
    record.startedAt = Date.now();
    record.finishedAt = undefined;
    record.abortRequested = false;
    record.progress = [];
    record.outputs = [];
    record.error = undefined;
    record.finalText = undefined;
    record.controller = new AbortController();
    record.costOffset = record.costTotal;
    record.turnsOffset = record.turns;
    record.toolCallsOffset = record.toolCalls;
    record.inputOffset = record.usage.input;
    record.outputOffset = record.usage.output;
    record.cacheReadOffset = record.usage.cacheRead;
    record.cacheWriteOffset = record.usage.cacheWrite;

    const subagentContext: SubagentDispatchContext = {
      id: record.id,
      name: record.name,
      title: record.title,
      originHistoryEntryId: record.originHistoryEntryId,
      controlPlane: this,
    };

    this.emit({ type: "subagent_spawned", state: this.toSnapshot(record) });

    record.completion = runSubagent({
      runtimeConfig: record.runtimeConfig,
      prompt,
      config,
      authPath,
      backend,
      signal: record.controller.signal,
      sessionId: record.id,
      personaId,
      originHistoryEntryId: record.originHistoryEntryId,
      subagentContext,
      modelResolver: record.modelResolver,
      messages: record.messages,
      onProgress: (event) => this.recordProgress(record.id, event),
      onToolUiEvent: (event) => this.recordToolUiEvent(record.id, event),
    })
      .then((result) => {
        record.status = "success";
        record.costTotal = record.costOffset + result.costTotal;
        record.turns = record.turnsOffset + result.turns;
        record.toolCalls = record.toolCallsOffset + result.toolCalls;
        record.finalText = result.finalText;
        record.finishedAt = Date.now();
        if (this.records.get(record.id) === record) {
          this.emit({ type: "subagent_finished", state: this.toSnapshot(record) });
        }
        return record;
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        const wasAborted = record.controller.signal.aborted || record.abortRequested;
        record.status = wasAborted ? "aborted" : "error";
        record.error = wasAborted ? undefined : message;
        record.finishedAt = Date.now();
        if (this.records.get(record.id) === record) {
          this.emit({ type: "subagent_finished", state: this.toSnapshot(record) });
        }
        return record;
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
    if (!record) {
      throw new Error(`Unknown subagent ID: ${id}`);
    }
    if (record.status !== "running") {
      return record;
    }
    return await record.completion;
  }

  private recordProgress(id: string, event: SubagentProgressEvent): void {
    const record = this.records.get(id);
    if (!record) return;

    record.costTotal = record.costOffset + event.costTotal;
    record.turns = record.turnsOffset + event.turns;
    record.toolCalls = record.toolCallsOffset + event.toolCalls;
    record.usage = {
      input: record.inputOffset + event.usage.input,
      output: record.outputOffset + event.usage.output,
      cacheRead: record.cacheReadOffset + event.usage.cacheRead,
      cacheWrite: record.cacheWriteOffset + event.usage.cacheWrite,
      contextWindowUsageTokens: event.usage.contextWindowUsageTokens,
      contextWindow: event.usage.contextWindow,
    };

    const text = event.text.trim();
    if (text) {
      record.progress.push({ kind: "progress", text });
      if (record.progress.length > MAX_PROGRESS_EVENTS) {
        record.progress.shift();
      }
    }

    this.emit({
      type: "subagent_progress",
      id,
      text,
      costTotal: record.costTotal,
      turns: record.turns,
      toolCalls: record.toolCalls,
      usage: record.usage,
    });
  }

  private recordToolUiEvent(id: string, event: SubagentToolUiEvent): void {
    const record = this.records.get(id);
    if (!record) return;

    record.costTotal = record.costOffset + event.costTotal;
    record.turns = record.turnsOffset + event.turns;
    record.toolCalls = record.toolCallsOffset + event.toolCalls;
    record.usage = {
      input: record.inputOffset + event.usage.input,
      output: record.outputOffset + event.usage.output,
      cacheRead: record.cacheReadOffset + event.usage.cacheRead,
      cacheWrite: record.cacheWriteOffset + event.usage.cacheWrite,
      contextWindowUsageTokens: event.usage.contextWindowUsageTokens,
      contextWindow: event.usage.contextWindow,
    };

    const text = formatToolUiEventForProgress(event.uiEvent) ?? "";
    if (text) {
      record.progress.push({ kind: "progress", text });
      if (record.progress.length > MAX_PROGRESS_EVENTS) {
        record.progress.shift();
      }
    }

    this.emit({
      type: "subagent_progress",
      id,
      text,
      costTotal: record.costTotal,
      turns: record.turns,
      toolCalls: record.toolCalls,
      usage: record.usage,
    });
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
      usage: record.usage,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      abortRequested: record.abortRequested,
      error: record.error,
      finalText: record.finalText,
    };
  }

  private toResult(record: SubagentRecord): SubagentResult {
    return {
      id: record.id,
      name: record.name,
      title: record.title,
      status: record.status,
      costTotal: record.costTotal,
      turns: record.turns,
      toolCalls: record.toolCalls,
      outputs: [...record.outputs],
      finalText: record.finalText,
      error: record.error,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
    };
  }

  private emit(event: SubagentUiEvent): void {
    this.onEvent(event);
  }
}
