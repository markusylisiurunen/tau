import { randomUUID } from "node:crypto";
import type { Config } from "../config/index.js";
import type { ToolExecutionBackend } from "../tools/execution_backend.js";
import type { ToolDispatchContext } from "../tools/registry.js";
import { formatToolUiEventForProgress } from "../utils/subagent_utils.js";
import type { SubagentProgressEvent, SubagentToolUiEvent } from "./subagent_engine.js";
import { runSubagent } from "./subagent_engine.js";
import type {
  SubagentName,
  SubagentRuntimeConfig,
  SubagentStateSnapshot,
  SubagentStatus,
  SubagentUiEvent,
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

type SubagentLogEntry = {
  kind: "progress" | "output";
  text: string;
};

type SubagentRecord = {
  id: string;
  name: SubagentName;
  title: string;
  status: SubagentStatus;
  costTotal: number;
  turns: number;
  toolCalls: number;
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
    for (const record of this.records.values()) {
      if (record.status === "running") {
        record.abortRequested = true;
        record.controller.abort();
      }
    }
    this.records.clear();
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
    config: Config;
    authPath?: string;
    backend: ToolExecutionBackend;
    personaId?: string;
  }): SubagentSpawnResult {
    if (this.getActiveCount() >= MAX_ACTIVE_SUBAGENTS) {
      return {
        ok: false,
        reason:
          `subagent limit reached (max ${MAX_ACTIVE_SUBAGENTS} active). ` +
          "wait for existing agents to finish.",
      };
    }

    const { runtimeConfig, prompt, title, config, authPath, backend, personaId } = options;
    const id = randomUUID();
    const controller = new AbortController();
    const startedAt = Date.now();

    const record: SubagentRecord = {
      id,
      name: runtimeConfig.name,
      title,
      status: "running",
      costTotal: 0,
      turns: 0,
      toolCalls: 0,
      startedAt,
      abortRequested: false,
      progress: [],
      outputs: [],
      controller,
      completion: Promise.resolve(undefined as never),
    };

    this.records.set(id, record);
    this.emit({ type: "subagent_spawned", state: this.toSnapshot(record) });

    const subagentContext: ToolDispatchContext["subagentContext"] = {
      id,
      name: runtimeConfig.name,
      title,
      controlPlane: this,
    };

    record.completion = runSubagent({
      runtimeConfig,
      prompt,
      config,
      authPath,
      backend,
      signal: controller.signal,
      sessionId: id,
      personaId,
      subagentContext,
      onProgress: (event) => this.recordProgress(id, event),
      onToolUiEvent: (event) => this.recordToolUiEvent(id, event),
    })
      .then((result) => {
        record.status = "success";
        record.costTotal = result.costTotal;
        record.turns = result.turns;
        record.toolCalls = result.toolCalls;
        record.finalText = result.finalText;
        record.finishedAt = Date.now();
        if (this.records.get(id) === record) {
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
        if (this.records.get(id) === record) {
          this.emit({ type: "subagent_finished", state: this.toSnapshot(record) });
        }
        return record;
      });

    return { ok: true, id };
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

  async waitFor(ids: string[], signal?: AbortSignal): Promise<SubagentResult[]> {
    const missing = ids.filter((id) => !this.records.has(id));
    if (missing.length > 0) {
      throw new Error(`unknown subagent id(s): ${missing.join(", ")}`);
    }

    const completions = ids.map((id) => this.waitForRecord(id));
    const all = Promise.all(completions);
    const resolved = await raceWithAbort(all, signal);
    return resolved.map((record) => this.toResult(record));
  }

  async terminate(id: string, signal?: AbortSignal): Promise<SubagentResult | undefined> {
    const record = this.records.get(id);
    if (!record) return undefined;

    if (record.status === "running") {
      if (!record.abortRequested) {
        record.abortRequested = true;
        this.emit({ type: "subagent_abort_requested", id });
      }
      record.controller.abort();
    }

    const completion = this.waitForRecord(id);
    const resolved = await raceWithAbort(completion, signal);
    return this.toResult(resolved);
  }

  getSnapshot(id: string): SubagentStateSnapshot | undefined {
    const record = this.records.get(id);
    return record ? this.toSnapshot(record) : undefined;
  }

  private async waitForRecord(id: string): Promise<SubagentRecord> {
    const record = this.records.get(id);
    if (!record) {
      throw new Error(`unknown subagent id: ${id}`);
    }
    if (record.status !== "running") {
      return record;
    }
    return await record.completion;
  }

  private recordProgress(id: string, event: SubagentProgressEvent): void {
    const record = this.records.get(id);
    if (!record) return;

    record.costTotal = event.costTotal;
    record.turns = event.turns;
    record.toolCalls = event.toolCalls;

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
    });
  }

  private recordToolUiEvent(id: string, event: SubagentToolUiEvent): void {
    const record = this.records.get(id);
    if (!record) return;

    record.costTotal = event.costTotal;
    record.turns = event.turns;
    record.toolCalls = event.toolCalls;

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
    });
  }

  private toSnapshot(record: SubagentRecord): SubagentStateSnapshot {
    return {
      id: record.id,
      name: record.name,
      title: record.title,
      status: record.status,
      costTotal: record.costTotal,
      turns: record.turns,
      toolCalls: record.toolCalls,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      abortRequested: record.abortRequested || undefined,
      error: record.error,
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
