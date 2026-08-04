import { truncateMiddle } from "../utils/truncate.js";
import type { HistoryEntry } from "./types.js";

export const HISTORY_REMOTE_ENTRY_MAX_BYTES = 1024 * 1024;
export const HISTORY_REPLICATION_OPERATION_MAX_BYTES = 6 * 1024 * 1024;

const MAX_REPLICATION_ENTRIES = 25;
const OPERATION_ID_SIZE_ALLOWANCE = 128;
const PAYLOAD_SIZE_ALLOWANCE = 1024;

export function projectHistoryEntryForRemote(entry: HistoryEntry): HistoryEntry {
  if (serializedBytes(entry) <= HISTORY_REMOTE_ENTRY_MAX_BYTES) {
    return structuredClone(entry);
  }

  if (entry.type !== "tool") {
    const base = { ...entry, content: "" };
    const content = projectRemoteValue(
      entry.content,
      HISTORY_REMOTE_ENTRY_MAX_BYTES - serializedBytes(base) - PAYLOAD_SIZE_ALLOWANCE,
    );
    return { ...entry, content };
  }

  const base = { ...entry, arguments: "", result: "" };
  const available = HISTORY_REMOTE_ENTRY_MAX_BYTES - serializedBytes(base) - PAYLOAD_SIZE_ALLOWANCE;
  const argumentsBytes = serializedBytes(entry.arguments);
  const resultBytes = serializedBytes(entry.result);
  let argumentsBudget = Math.min(argumentsBytes, Math.floor(available / 2));
  let resultBudget = Math.min(resultBytes, available - argumentsBudget);
  let remaining = available - argumentsBudget - resultBudget;

  const resultGrowth = Math.min(remaining, resultBytes - resultBudget);
  resultBudget += resultGrowth;
  remaining -= resultGrowth;
  argumentsBudget += Math.min(remaining, argumentsBytes - argumentsBudget);

  return {
    ...entry,
    arguments: projectRemoteValue(entry.arguments, argumentsBudget),
    result: projectRemoteValue(entry.result, resultBudget),
  };
}

export function batchHistoryEntriesForRemote(
  sessionId: string,
  entries: HistoryEntry[],
): HistoryEntry[][] {
  const batches: HistoryEntry[][] = [];
  let batch: HistoryEntry[] = [];

  for (const entry of entries.map(projectHistoryEntryForRemote)) {
    const candidate = [...batch, entry];
    if (
      candidate.length <= MAX_REPLICATION_ENTRIES &&
      appendOperationBytes(sessionId, candidate) <= HISTORY_REPLICATION_OPERATION_MAX_BYTES
    ) {
      batch = candidate;
      continue;
    }
    if (batch.length > 0) batches.push(batch);
    batch = [entry];
  }

  if (batch.length > 0) batches.push(batch);
  return batches;
}

function projectRemoteValue(value: unknown, maxBytes: number): unknown {
  const encoded = JSON.stringify(value) ?? String(value);
  const encodedBytes = Buffer.byteLength(encoded, "utf8");
  if (encodedBytes <= maxBytes) return structuredClone(value);

  const source = typeof value === "string" ? value : encoded;
  const marker = `\n... ${encodedBytes} byte payload middle-truncated for remote history ...\n`;
  let lower = 0;
  let upper = Math.min(Buffer.byteLength(source, "utf8"), maxBytes);
  let projected = "";

  while (lower <= upper) {
    const candidateBytes = Math.floor((lower + upper) / 2);
    const candidate = truncateMiddle(source, {
      maxLines: Number.MAX_SAFE_INTEGER,
      maxBytes: candidateBytes,
      marker,
    }).content;
    if (serializedBytes(candidate) <= maxBytes) {
      projected = candidate;
      lower = candidateBytes + 1;
    } else {
      upper = candidateBytes - 1;
    }
  }

  return projected;
}

function appendOperationBytes(sessionId: string, entries: HistoryEntry[]): number {
  return serializedBytes({
    id: "x".repeat(OPERATION_ID_SIZE_ALLOWANCE),
    sessionId,
    type: "append",
    entries,
  });
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? String(value), "utf8");
}
