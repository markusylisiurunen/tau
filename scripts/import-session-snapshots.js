#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { RemoteHistoryClient } from "../dist/core/history/remote_history_client.js";
import { batchHistoryEntriesForRemote } from "../dist/core/history/replication.js";
import {
  assistantHistoryEntries,
  toolHistoryEntry,
  userHistoryEntry,
} from "../dist/core/history/transcript.js";
import { parseStoredSessionDocument } from "../dist/store/session_snapshot_migrations.js";
import { discoverLocalWorkspaceRepositories } from "../dist/tui/session_creation_attributes.js";

const MAX_OPERATIONS_PER_REQUEST = 10;
const MAX_REQUEST_BYTES = 7.5 * 1024 * 1024;
const MAX_ATTRIBUTE_VALUE_LENGTH = 1_024;
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = [500, 1_500, 3_000];

export function parseSnapshotForImport(value) {
  if (isLegacyCheckpointSnapshot(value)) {
    const messages = value.historyEntries.map((entry) => {
      if (!isRecord(entry) || typeof entry.id !== "string" || !isRecord(entry.message)) {
        throw new Error("legacy checkpoint history entries must contain an id and message");
      }
      return {
        id: entry.id,
        state: "committed",
        modelVisible: true,
        message: entry.message,
      };
    });
    const timestamps = messages.flatMap(({ message }) =>
      typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
        ? [message.timestamp]
        : [],
    );
    return {
      sessionId: value.sessionId,
      attributes: {},
      createdAt: timestamps.length > 0 ? Math.min(...timestamps) : 0,
      executionEnvironment: value.executionEnvironment,
      messages,
      tools: {},
    };
  }
  return parseStoredSessionDocument(value).snapshot;
}

export function inferSnapshotRepositories(
  snapshots,
  { home = homedir(), discoverRepositories = discoverLocalWorkspaceRepositories } = {},
) {
  const repositoriesByCwd = new Map();
  const discoveredByCwd = new Map();
  for (const snapshot of snapshots) {
    const cwd = snapshot.executionEnvironment?.cwd;
    if (typeof cwd !== "string") continue;
    const storedRepository = snapshot.attributes.repository;
    if (typeof storedRepository === "string") {
      repositoriesByCwd.set(cwd, storedRepository.split(","));
      continue;
    }
    if (!discoveredByCwd.has(cwd)) {
      discoveredByCwd.set(cwd, cwd === home ? [] : discoverRepositories(cwd));
    }
    const discovered = discoveredByCwd.get(cwd);
    if (discovered.length > 0) repositoriesByCwd.set(cwd, discovered);
  }

  const repositoriesByParent = stableParentRepositoryMappings(repositoriesByCwd);
  const repositoriesByName = repositoryNameMappings(repositoriesByCwd.values());
  let inferredCount = 0;
  const inferred = snapshots.map((snapshot) => {
    if (typeof snapshot.attributes.repository === "string") return snapshot;
    const cwd = snapshot.executionEnvironment?.cwd;
    if (typeof cwd !== "string") return snapshot;
    const repositories =
      repositoriesByCwd.get(cwd) ??
      repositoriesByParent.get(dirname(cwd)) ??
      matchWorkspaceRepositories(cwd, repositoriesByName);
    if (!repositories || repositories.length === 0) return snapshot;
    const repository = repositories.join(",");
    if (repository.length > MAX_ATTRIBUTE_VALUE_LENGTH) return snapshot;
    inferredCount += 1;
    return {
      ...snapshot,
      attributes: { ...snapshot.attributes, repository },
    };
  });
  return { snapshots: inferred, inferredCount };
}

export function inferSnapshotSources(snapshots, { home = homedir() } = {}) {
  const coworkRoot = join(home, "cowork", "workspaces");
  const telegramRoot = join(home, "repos");
  let inferredCount = 0;
  const inferred = snapshots.map((snapshot) => {
    if (typeof snapshot.attributes.source === "string") return snapshot;
    const cwd = snapshot.executionEnvironment?.cwd;
    if (typeof cwd !== "string") return snapshot;
    const source = isWithin(coworkRoot, cwd)
      ? "cowork"
      : isTelegramWorkspace(telegramRoot, cwd)
        ? "telegram"
        : "tui";
    inferredCount += 1;
    return { ...snapshot, attributes: { ...snapshot.attributes, source } };
  });
  return { snapshots: inferred, inferredCount };
}

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

export function buildImportOperations(snapshot, entries) {
  const session = {
    sessionId: snapshot.sessionId,
    attributes: snapshot.attributes,
    createdAt: snapshot.createdAt,
  };
  return [
    withOperationId({ sessionId: snapshot.sessionId, type: "create", session }),
    ...batchHistoryEntriesForRemote(snapshot.sessionId, entries).map((batch) =>
      withOperationId({ sessionId: snapshot.sessionId, type: "append", entries: batch }),
    ),
  ];
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
  const filenames = (await readdir(options.sessionsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  const loaded = [];
  let skipped = 0;
  for (const filename of filenames) {
    const path = join(options.sessionsDirectory, filename);
    try {
      loaded.push({
        filename,
        snapshot: parseSnapshotForImport(JSON.parse(await readFile(path, "utf8"))),
      });
    } catch (error) {
      skipped += 1;
      console.warn(
        `skipping ${filename}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const repositories = inferSnapshotRepositories(loaded.map(({ snapshot }) => snapshot));
  const sources = inferSnapshotSources(repositories.snapshots);
  let imported = 0;
  let entryCount = 0;
  for (let index = 0; index < loaded.length; index += 1) {
    const { filename } = loaded[index];
    const snapshot = sources.snapshots[index];
    try {
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
    `${options.dryRun ? "checked" : "imported"} ${imported} snapshots and ${entryCount} entries; inferred repository for ${repositories.inferredCount} and source for ${sources.inferredCount}; skipped ${skipped}`,
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

function isWithin(root, path) {
  const relPath = relative(root, path);
  return relPath === "" || (!relPath.startsWith(`..${sep}`) && relPath !== "..");
}

function isTelegramWorkspace(root, path) {
  if (!isWithin(root, path)) return false;
  const segments = relative(root, path).split(sep).filter(Boolean);
  return segments.length >= 2;
}

function stableParentRepositoryMappings(repositoriesByCwd) {
  const candidates = new Map();
  for (const [cwd, repositories] of repositoriesByCwd) {
    const parent = dirname(cwd);
    const serialized = repositories.join(",");
    const values = candidates.get(parent) ?? new Set();
    values.add(serialized);
    candidates.set(parent, values);
  }
  return new Map(
    Array.from(candidates).flatMap(([parent, values]) =>
      values.size === 1 ? [[parent, [...values][0].split(",")]] : [],
    ),
  );
}

function repositoryNameMappings(repositoryLists) {
  const candidates = new Map();
  for (const repositories of repositoryLists) {
    for (const repository of repositories) {
      const name = repositoryName(repository);
      if (!name) continue;
      const values = candidates.get(name) ?? new Set();
      values.add(repository);
      candidates.set(name, values);
    }
  }
  return new Map(
    Array.from(candidates).flatMap(([name, values]) =>
      values.size === 1 ? [[name, [...values][0]]] : [],
    ),
  );
}

function matchWorkspaceRepositories(cwd, repositoriesByName) {
  const workspaceName = basename(cwd);
  const ownerSeparator = workspaceName.indexOf("--");
  const candidates = [
    normalizeWorkspaceName(workspaceName),
    normalizeWorkspaceName(basename(dirname(cwd))),
    ...(ownerSeparator >= 0
      ? [normalizeWorkspaceName(workspaceName.slice(ownerSeparator + 2))]
      : []),
  ];
  const matches = Array.from(repositoriesByName)
    .filter(([name]) =>
      candidates.some((candidate) => candidate === name || candidate.startsWith(`${name}-`)),
    )
    .sort((left, right) => right[0].length - left[0].length);
  if (matches.length === 0 || matches[1]?.[0].length === matches[0][0].length) return undefined;
  return [matches[0][1]];
}

function repositoryName(repository) {
  const slash = repository.lastIndexOf("/");
  return slash >= 0 ? normalizeWorkspaceName(repository.slice(slash + 1)) : undefined;
}

function normalizeWorkspaceName(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isLegacyCheckpointSnapshot(value) {
  return (
    isRecord(value) &&
    typeof value.sessionId === "string" &&
    !("messages" in value) &&
    Array.isArray(value.historyEntries)
  );
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
