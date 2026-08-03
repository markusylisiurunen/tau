#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RemoteHistoryClient } from "../dist/core/history/remote_history_client.js";
import {
  assistantHistoryEntries,
  toolHistoryEntry,
  userHistoryEntry,
} from "../dist/core/history/transcript.js";
import { parseStoredSessionDocument } from "../dist/store/session_snapshot_migrations.js";

const MAX_APPEND_ENTRIES = 25;
const MAX_OPERATIONS_PER_REQUEST = 10;
const MAX_OPERATION_BYTES = 7 * 1024 * 1024;
const MAX_REQUEST_BYTES = 7.5 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = [500, 1_500, 3_000];

export function snapshotToHistoryEntries(snapshot) {
  const calls = new Map();
  for (const wrapped of snapshot.messages) {
    if (wrapped.message.role !== "assistant") continue;
    for (const content of wrapped.message.content) {
      if (content.type === "toolCall") {
        calls.set(content.id, { historyEntryId: wrapped.id, call: content });
      }
    }
  }

  const tools = new Map(Object.values(snapshot.tools).map((tool) => [tool.toolCallId, tool]));
  const entries = [];
  for (const wrapped of snapshot.messages) {
    if (wrapped.state !== "committed" && wrapped.state !== "interrupted") continue;
    const message = wrapped.message;
    if (message.role === "user") {
      entries.push(userHistoryEntry(wrapped.id, message));
    } else if (message.role === "assistant") {
      entries.push(...assistantHistoryEntries(wrapped.id, message));
    } else if (message.role === "toolResult") {
      const found = calls.get(message.toolCallId);
      if (!found) continue;
      const tool = tools.get(message.toolCallId);
      entries.push(
        toolHistoryEntry({
          callHistoryEntryId: found.historyEntryId,
          resultHistoryEntryId: wrapped.id,
          call: found.call,
          result: message,
          outcome: terminalToolOutcome(tool?.status, message.isError),
        }),
      );
    }
  }
  return entries;
}

export function buildImportOperations(snapshot, entries, warn = console.warn) {
  const session = {
    sessionId: snapshot.sessionId,
    attributes: snapshot.attributes,
    createdAt: snapshot.createdAt,
  };
  const operations = [withOperationId({ sessionId: snapshot.sessionId, type: "create", session })];
  let batch = [];
  for (const entry of entries) {
    const candidate = [...batch, entry];
    const operation = { sessionId: snapshot.sessionId, type: "append", entries: candidate };
    if (
      candidate.length <= MAX_APPEND_ENTRIES &&
      Buffer.byteLength(JSON.stringify(operation)) <= MAX_OPERATION_BYTES
    ) {
      batch = candidate;
      continue;
    }
    if (batch.length > 0) {
      operations.push(
        withOperationId({ sessionId: snapshot.sessionId, type: "append", entries: batch }),
      );
      batch = [];
    }
    const single = { sessionId: snapshot.sessionId, type: "append", entries: [entry] };
    if (Buffer.byteLength(JSON.stringify(single)) > MAX_OPERATION_BYTES) {
      warn(`skipping oversized entry '${entry.id}' in session '${snapshot.sessionId}'`);
    } else {
      batch = [entry];
    }
  }
  if (batch.length > 0) {
    operations.push(
      withOperationId({ sessionId: snapshot.sessionId, type: "append", entries: batch }),
    );
  }
  return operations;
}

export function batchImportOperations(operations) {
  const batches = [];
  let batch = [];
  for (const operation of operations) {
    const candidate = [...batch, operation];
    const bodyBytes = Buffer.byteLength(JSON.stringify({ operations: candidate }));
    if (candidate.length <= MAX_OPERATIONS_PER_REQUEST && bodyBytes <= MAX_REQUEST_BYTES) {
      batch = candidate;
      continue;
    }
    if (batch.length > 0) batches.push(batch);
    batch = [operation];
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

async function main() {
  const options = await parseOptions(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const client = options.dryRun ? undefined : new RemoteHistoryClient(await resolveTarget(options));
  const filenames = (await readdir(options.sessionsDirectory))
    .filter((filename) => filename.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b));
  let imported = 0;
  let skipped = 0;
  let entryCount = 0;

  for (const filename of filenames) {
    const path = join(options.sessionsDirectory, filename);
    try {
      const raw = JSON.parse(await readFile(path, "utf8"));
      const snapshot = parseStoredSessionDocument(raw).snapshot;
      const entries = snapshotToHistoryEntries(snapshot);
      const operations = buildImportOperations(snapshot, entries);
      if (!options.dryRun) {
        for (const batch of batchImportOperations(operations)) {
          await applyWithRetry(client, batch);
        }
      }
      imported += 1;
      entryCount += entries.length;
      console.log(
        `${options.dryRun ? "would import" : "imported"} ${snapshot.sessionId} (${entries.length} entries)`,
      );
    } catch (error) {
      skipped += 1;
      console.warn(
        `skipping ${filename}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  console.log(
    `${options.dryRun ? "checked" : "imported"} ${imported} snapshots and ${entryCount} entries; skipped ${skipped}`,
  );
  if (skipped > 0) process.exitCode = 1;
}

async function parseOptions(argv) {
  const options = {
    sessionsDirectory: join(homedir(), ".config", "tau", "sessions"),
    dryRun: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--sessions-dir" || argument.startsWith("--sessions-dir=")) {
      const parsed = optionValue(argument, argv, index);
      options.sessionsDirectory = resolve(parsed.value);
      index = parsed.nextIndex;
    } else if (argument === "--endpoint" || argument.startsWith("--endpoint=")) {
      const parsed = optionValue(argument, argv, index);
      options.endpoint = parsed.value;
      index = parsed.nextIndex;
    } else {
      throw new Error(`unknown option: ${argument}`);
    }
  }
  return options;
}

async function resolveTarget(options) {
  const config = await readGlobalHistoryConfig();
  const endpoint = normalizeEndpoint(
    options.endpoint ?? process.env.TAU_HISTORY_ENDPOINT ?? config?.endpoint,
  );
  const configuredEnv = config?.apiKeyEnv;
  const apiKey =
    process.env.TAU_HISTORY_API_KEY?.trim() ||
    (configuredEnv ? process.env[configuredEnv]?.trim() : undefined) ||
    config?.apiKey?.trim();
  if (!endpoint) {
    throw new Error(
      "history endpoint is required through --endpoint, TAU_HISTORY_ENDPOINT, or global Tau config",
    );
  }
  if (!apiKey) {
    throw new Error(
      "history API key is required through TAU_HISTORY_API_KEY or the global Tau config",
    );
  }
  return { endpoint, apiKey };
}

async function readGlobalHistoryConfig() {
  try {
    const value = JSON.parse(
      await readFile(join(homedir(), ".config", "tau", "config.json"), "utf8"),
    );
    return typeof value === "object" && value !== null && typeof value.history === "object"
      ? value.history
      : undefined;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function applyWithRetry(client, operations) {
  let lastError;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await client.applyOperations(operations, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
      return;
    } catch (error) {
      lastError = error;
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
    }
  }
  throw lastError;
}

function withOperationId(operation) {
  return {
    id: `snapshot-import:${createHash("sha256").update(JSON.stringify(operation)).digest("hex")}`,
    ...operation,
  };
}

function terminalToolOutcome(status, isError) {
  if (
    status === "succeeded" ||
    status === "failed" ||
    status === "blocked" ||
    status === "cancelled"
  ) {
    return status;
  }
  return isError ? "failed" : "succeeded";
}

function normalizeEndpoint(value) {
  const endpoint = value?.trim().replace(/\/+$/, "");
  if (!endpoint) return undefined;
  const url = new URL(endpoint);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("history endpoint must use http or https");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("history endpoint must not include a path, query, or fragment");
  }
  return url.origin;
}

function optionValue(argument, argv, index) {
  const equals = argument.indexOf("=");
  if (equals >= 0) {
    const value = argument.slice(equals + 1);
    if (!value) throw new Error(`missing value for ${argument.slice(0, equals)}`);
    return { value, nextIndex: index };
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) throw new Error(`missing value for ${argument}`);
  return { value, nextIndex: index + 1 };
}

function printHelp() {
  console.log(`usage:
  npm run build
  node scripts/import-session-snapshots.js [--sessions-dir <path>] [--endpoint <url>] [--dry-run]

The endpoint and API key default to the global Tau history config. TAU_HISTORY_ENDPOINT and
TAU_HISTORY_API_KEY override them. Snapshot files are read but never modified or deleted.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
