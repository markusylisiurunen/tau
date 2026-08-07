import type { SessionProtocolSnapshot } from "../protocol/session_protocol.js";
import { validateSessionProtocolResult } from "../protocol/session_protocol.js";

export const STORED_SESSION_DOCUMENT_FORMAT = "tau-session" as const;
export const STORED_SESSION_DOCUMENT_VERSION = 6 as const;
export const LEGACY_SESSION_MODEL_CONTEXT_KEY = "legacy-v3";

export type StoredSessionDocument = {
  format: typeof STORED_SESSION_DOCUMENT_FORMAT;
  version: typeof STORED_SESSION_DOCUMENT_VERSION;
  snapshot: SessionProtocolSnapshot;
};

type StoredSessionMigration = (snapshot: unknown) => unknown;

const storedSessionMigrations = new Map<number, StoredSessionMigration>([
  [0, migrateStoredSessionV0ToV1],
  [1, migrateStoredSessionV1ToV2],
  [2, migrateStoredSessionV2ToV3],
  [3, migrateStoredSessionV3ToV4],
  [4, migrateStoredSessionV4ToV5],
  [5, migrateStoredSessionV5ToV6],
]);

export class UnsupportedStoredSessionVersionError extends Error {
  constructor(readonly version: number) {
    super(
      version > STORED_SESSION_DOCUMENT_VERSION
        ? `stored session was created by a newer Tau version (storage version ${version})`
        : `stored session storage version ${version} is unsupported`,
    );
    this.name = "UnsupportedStoredSessionVersionError";
  }
}

export function createStoredSessionDocument(
  snapshot: SessionProtocolSnapshot,
): StoredSessionDocument {
  return {
    format: STORED_SESSION_DOCUMENT_FORMAT,
    version: STORED_SESSION_DOCUMENT_VERSION,
    snapshot,
  };
}

export function parseStoredSessionDocument(value: unknown): StoredSessionDocument {
  const decoded = decodeStoredSessionDocument(value);
  let version = decoded.version;
  let snapshot = decoded.snapshot;

  if (version > STORED_SESSION_DOCUMENT_VERSION) {
    throw new UnsupportedStoredSessionVersionError(version);
  }

  while (version < STORED_SESSION_DOCUMENT_VERSION) {
    const migration = storedSessionMigrations.get(version);
    if (!migration) {
      throw new UnsupportedStoredSessionVersionError(version);
    }
    snapshot = migration(snapshot);
    version += 1;
  }

  const validated = validateSessionProtocolResult("session.snapshot", snapshot);
  if (!validated.ok) {
    throw new Error(validated.error.message);
  }

  return createStoredSessionDocument(validated.value);
}

function decodeStoredSessionDocument(value: unknown): {
  version: number;
  snapshot: unknown;
} {
  if (!isRecord(value) || value.format !== STORED_SESSION_DOCUMENT_FORMAT) {
    return { version: 0, snapshot: value };
  }
  if (!Number.isInteger(value.version) || (value.version as number) < 0) {
    throw new Error("stored session document version must be a non-negative integer");
  }
  if (!("snapshot" in value)) {
    throw new Error("stored session document is missing its snapshot");
  }
  return {
    version: value.version as number,
    snapshot: value.snapshot,
  };
}

function migrateStoredSessionV0ToV1(value: unknown): unknown {
  if (!isRecord(value)) {
    throw new Error("legacy stored session snapshot must be an object");
  }

  const snapshot = structuredClone(value);
  if (!("agentState" in snapshot)) {
    snapshot.agentState = {
      revision: isNonNegativeInteger(snapshot.revision) ? snapshot.revision : 0,
      modelContextKey: LEGACY_SESSION_MODEL_CONTEXT_KEY,
    };
  }
  if (!("costTotal" in snapshot)) snapshot.costTotal = 0;
  removeLegacyPruningPresentation(snapshot);
  removeLegacyOrphanedToolPresentation(snapshot);
  return snapshot;
}

function migrateStoredSessionV1ToV2(value: unknown): unknown {
  if (!isRecord(value)) {
    throw new Error("stored session snapshot must be an object");
  }

  const snapshot = structuredClone(value);
  removeUnrecoverableAgentPresentation(snapshot);
  return snapshot;
}

function migrateStoredSessionV2ToV3(value: unknown): unknown {
  if (!isRecord(value)) {
    throw new Error("stored session snapshot must be an object");
  }

  const snapshot = structuredClone(value);
  snapshot.goal = null;
  return snapshot;
}

function migrateStoredSessionV3ToV4(value: unknown): unknown {
  return value;
}

function migrateStoredSessionV4ToV5(value: unknown): unknown {
  if (!isRecord(value)) {
    throw new Error("stored session snapshot must be an object");
  }

  const snapshot = structuredClone(value);
  if (!("attributes" in snapshot)) snapshot.attributes = {};
  if (!("createdAt" in snapshot)) snapshot.createdAt = earliestSnapshotTimestamp(snapshot);
  return snapshot;
}

function migrateStoredSessionV5ToV6(value: unknown): unknown {
  if (!isRecord(value)) {
    throw new Error("stored session snapshot must be an object");
  }

  const snapshot = structuredClone(value);
  migrateModelContextKey(snapshot);
  if (!Array.isArray(snapshot.timeline)) {
    throw new Error("stored session snapshot timeline must be an array");
  }

  const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
  const messagesById = new Map(
    messages.flatMap((message) =>
      isRecord(message) && typeof message.id === "string" ? [[message.id, message] as const] : [],
    ),
  );
  const tools = isRecord(snapshot.tools) ? snapshot.tools : {};
  const toolsByMessageId = new Map<string, Array<[string, Record<string, unknown>]>>();
  for (const [toolId, tool] of Object.entries(tools)) {
    if (!isRecord(tool)) continue;
    const position = isRecord(tool.origin)
      ? tool.origin
      : isRecord(tool.call)
        ? tool.call
        : undefined;
    if (!position || typeof position.messageId !== "string") continue;
    const messageTools = toolsByMessageId.get(position.messageId) ?? [];
    messageTools.push([toolId, tool]);
    toolsByMessageId.set(position.messageId, messageTools);
  }
  for (const messageTools of toolsByMessageId.values()) {
    messageTools.sort(([, left], [, right]) => {
      const leftPosition = isRecord(left.origin) ? left.origin : left.call;
      const rightPosition = isRecord(right.origin) ? right.origin : right.call;
      return (
        numericValue(leftPosition, "contentIndex") - numericValue(rightPosition, "contentIndex")
      );
    });
  }

  let sequence = 0;
  const items: Record<string, unknown>[] = [];
  const operations: Record<string, unknown> = {};
  const append = (item: Record<string, unknown>, createdAt: number): void => {
    sequence += 1;
    items.push({ ...item, sequence, createdAt });
  };

  for (const value of snapshot.timeline) {
    if (!isRecord(value) || typeof value.id !== "string") continue;
    if (value.type === "message" && typeof value.messageId === "string") {
      append(
        { type: "message", id: value.id, messageId: value.messageId },
        messageTimestamp(messagesById.get(value.messageId)),
      );
      for (const [toolId, tool] of toolsByMessageId.get(value.messageId) ?? []) {
        append(
          { type: "tool", id: `timeline-tool-${toolId}`, toolId },
          numericValue(tool, "startedAt") || messageTimestamp(messagesById.get(value.messageId)),
        );
      }
      continue;
    }
    if (value.type === "notice" && isRecord(value.notice)) {
      const title =
        typeof value.notice.title === "string"
          ? value.notice.title
          : typeof value.notice.text === "string"
            ? (value.notice.text.replace(/\r\n?/g, "\n").split("\n")[0]?.trim() ?? "")
            : "";
      const content = Array.isArray(value.notice.content)
        ? value.notice.content.filter((line): line is string => typeof line === "string")
        : typeof value.notice.text === "string"
          ? value.notice.text.replace(/\r\n?/g, "\n").split("\n").slice(1)
          : [];
      const createdAt = numericValue(value.notice, "timestamp");
      append(
        {
          type: "notice",
          id: value.id,
          notice: {
            kind: "tau.recovered.notice",
            version: 1,
            severity: ["info", "warn", "error"].includes(String(value.notice.severity))
              ? value.notice.severity
              : "info",
            subject: isRecord(value.notice.subject) ? value.notice.subject : { type: "session" },
            presentation: {
              title: title || "session notice",
              ...(content.length > 0 ? { content } : {}),
            },
            data: {},
          },
        },
        createdAt,
      );
      continue;
    }
    if (value.type === "operation" && isRecord(value.operation)) {
      const operation = { id: value.id, ...value.operation };
      operations[value.id] = operation;
      append(
        { type: "operation", id: value.id, operationId: value.id },
        numericValue(value.operation, "startedAt"),
      );
    }
  }

  snapshot.timeline = { epoch: 1, sequence, items };
  snapshot.operations = operations;
  normalizeStoredOperations(snapshot);
  migrateStoredTurnOutcomes(snapshot);
  return snapshot;
}

function normalizeStoredOperations(snapshot: Record<string, unknown>): void {
  if (!isRecord(snapshot.operations)) return;

  for (const [id, value] of Object.entries(snapshot.operations)) {
    if (!isRecord(value)) continue;
    const operation = {
      id: typeof value.id === "string" && value.id ? value.id : id,
      kind: value.kind,
      status: value.status,
      startedAt: value.startedAt,
    };
    const finishedAt =
      typeof value.finishedAt === "number" && Number.isFinite(value.finishedAt)
        ? value.finishedAt
        : value.startedAt;
    switch (value.status) {
      case "running":
        snapshot.operations[id] = operation;
        break;
      case "succeeded":
        snapshot.operations[id] = { ...operation, finishedAt };
        break;
      case "failed":
        snapshot.operations[id] = {
          ...operation,
          finishedAt,
          error:
            typeof value.error === "string" && value.error.length > 0
              ? value.error
              : "operation failed before recovery",
        };
        break;
      case "skipped":
        snapshot.operations[id] = {
          ...operation,
          finishedAt,
          reason: "no-eligible-history",
        };
        break;
      case "cancelled":
        snapshot.operations[id] = {
          ...operation,
          finishedAt,
          reason:
            value.reason === "interrupted" || value.reason === "session-recovered"
              ? value.reason
              : "session-recovered",
        };
        break;
    }
  }
}

function migrateStoredTurnOutcomes(snapshot: Record<string, unknown>): void {
  if (
    !Array.isArray(snapshot.messages) ||
    !isRecord(snapshot.timeline) ||
    !Array.isArray(snapshot.timeline.items)
  ) {
    return;
  }

  const activeMessageIds = new Set(
    snapshot.timeline.items.flatMap((item) =>
      isRecord(item) && item.type === "message" && typeof item.messageId === "string"
        ? [item.messageId]
        : [],
    ),
  );
  const existingNoticeSubjects = new Set(
    snapshot.timeline.items.flatMap((item) => {
      if (!isRecord(item) || item.type !== "notice" || !isRecord(item.notice)) return [];
      if (item.notice.kind !== "tau.turn.failed" && item.notice.kind !== "tau.turn.blocked") {
        return [];
      }
      return isRecord(item.notice.subject) &&
        item.notice.subject.type === "message" &&
        typeof item.notice.subject.id === "string"
        ? [item.notice.subject.id]
        : [];
    }),
  );
  const timelineIds = new Set(
    snapshot.timeline.items.flatMap((item) =>
      isRecord(item) && typeof item.id === "string" ? [item.id] : [],
    ),
  );
  let sequence = numericValue(snapshot.timeline, "sequence");

  for (const [index, message] of snapshot.messages.entries()) {
    if (!isRecord(message) || !isRecord(message.turn)) continue;
    const turn = message.turn;
    delete message.turn;
    if (
      typeof message.id !== "string" ||
      !activeMessageIds.has(message.id) ||
      existingNoticeSubjects.has(message.id) ||
      (turn.status !== "failed" && turn.status !== "blocked") ||
      (turn.status === "failed" && hasFollowingAssistantError(snapshot.messages, index))
    ) {
      continue;
    }

    const blocked = turn.status === "blocked";
    const baseId = `recovered-turn-${blocked ? "blocked" : "failed"}-${message.id}`;
    let id = baseId;
    for (let suffix = 2; timelineIds.has(id); suffix += 1) {
      id = `${baseId}-${suffix}`;
    }
    timelineIds.add(id);
    existingNoticeSubjects.add(message.id);
    const content = blocked
      ? typeof turn.message === "string"
        ? turn.message
        : "the turn did not complete"
      : typeof turn.errorMessage === "string"
        ? turn.errorMessage
        : "the turn did not complete";
    const reason =
      typeof turn.reason === "string"
        ? turn.reason
        : blocked
          ? "auto-compaction-failed"
          : "recovered-turn-failure";
    sequence += 1;
    snapshot.timeline.items.push({
      type: "notice",
      id,
      sequence,
      createdAt: messageTimestamp(message),
      notice: {
        kind: blocked ? "tau.turn.blocked" : "tau.turn.failed",
        version: 1,
        severity: "error",
        subject: { type: "message", id: message.id },
        presentation: {
          title: blocked ? "turn blocked" : "turn failed",
          content: [content],
        },
        data: { reason },
      },
    });
  }

  snapshot.timeline.sequence = sequence;
}

function hasFollowingAssistantError(messages: unknown[], userIndex: number): boolean {
  for (const message of messages.slice(userIndex + 1)) {
    if (!isRecord(message) || !isRecord(message.message)) continue;
    if (message.message.role === "user") return false;
    if (message.message.role === "assistant" && message.message.stopReason === "error") {
      return true;
    }
  }
  return false;
}

function migrateModelContextKey(snapshot: Record<string, unknown>): void {
  if (!isRecord(snapshot.agentState)) return;
  if (
    !("modelContextKey" in snapshot.agentState) &&
    typeof snapshot.agentState.contextEpoch === "string"
  ) {
    snapshot.agentState.modelContextKey = snapshot.agentState.contextEpoch;
  }
  delete snapshot.agentState.contextEpoch;

  if (!isRecord(snapshot.agentState.usageCheckpoint)) return;
  if (
    !("modelContextKey" in snapshot.agentState.usageCheckpoint) &&
    typeof snapshot.agentState.usageCheckpoint.contextEpoch === "string"
  ) {
    snapshot.agentState.usageCheckpoint.modelContextKey =
      snapshot.agentState.usageCheckpoint.contextEpoch;
  }
  delete snapshot.agentState.usageCheckpoint.contextEpoch;
}

function numericValue(value: unknown, key: string): number {
  if (!isRecord(value)) return 0;
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0
    ? candidate
    : 0;
}

function messageTimestamp(message: Record<string, unknown> | undefined): number {
  return message && isRecord(message.message) ? numericValue(message.message, "timestamp") : 0;
}

function removeUnrecoverableAgentPresentation(snapshot: Record<string, unknown>): void {
  snapshot.agents = {};
  if (!isRecord(snapshot.facets)) return;
  for (const [facetId, facet] of Object.entries(snapshot.facets)) {
    if (isRecord(facet) && isRecord(facet.subject) && facet.subject.type === "agent") {
      delete snapshot.facets[facetId];
    }
  }
}

function removeLegacyPruningPresentation(snapshot: Record<string, unknown>): void {
  const removedOperationIds = new Set<string>();
  if (Array.isArray(snapshot.timeline)) {
    snapshot.timeline = snapshot.timeline.filter((item) => {
      if (
        isRecord(item) &&
        item.type === "operation" &&
        isRecord(item.operation) &&
        item.operation.kind === "prune"
      ) {
        if (typeof item.id === "string") removedOperationIds.add(item.id);
        return false;
      }
      return true;
    });
  }

  const removedFacetIds = new Set<string>();
  if (isRecord(snapshot.facets)) {
    for (const [facetId, value] of Object.entries(snapshot.facets)) {
      if (!isRecord(value)) continue;
      if (
        isRecord(value.subject) &&
        value.subject.type === "operation" &&
        typeof value.subject.id === "string" &&
        removedOperationIds.has(value.subject.id)
      ) {
        delete snapshot.facets[facetId];
        removedFacetIds.add(facetId);
        continue;
      }
      if (value.kind !== "tau.tool-ui-events" || !isRecord(value.data)) continue;
      if (!Array.isArray(value.data.events)) continue;

      const events = value.data.events.filter(
        (event) => !isRecord(event) || event.type !== "tool_pruned",
      );
      if (events.length === value.data.events.length) continue;
      if (events.length === 0) {
        delete snapshot.facets[facetId];
        removedFacetIds.add(facetId);
      } else {
        value.data.events = events;
      }
    }
  }

  if (removedFacetIds.size === 0 || !isRecord(snapshot.tools)) return;
  for (const value of Object.values(snapshot.tools)) {
    if (!isRecord(value) || !Array.isArray(value.facetIds)) continue;
    value.facetIds = value.facetIds.filter(
      (facetId) => typeof facetId !== "string" || !removedFacetIds.has(facetId),
    );
  }
}

function removeLegacyOrphanedToolPresentation(snapshot: Record<string, unknown>): void {
  if (!Array.isArray(snapshot.messages) || !isRecord(snapshot.tools)) return;
  const messageIds = new Set(
    snapshot.messages.flatMap((message) =>
      isRecord(message) && typeof message.id === "string" ? [message.id] : [],
    ),
  );
  const removedToolIds = new Set<string>();
  for (const [toolId, tool] of Object.entries(snapshot.tools)) {
    if (!isRecord(tool)) continue;
    const reference = isRecord(tool.origin)
      ? tool.origin
      : isRecord(tool.call)
        ? tool.call
        : undefined;
    const referencesMissingMessage =
      !reference || typeof reference.messageId !== "string" || !messageIds.has(reference.messageId);
    const referencesMissingResult =
      typeof tool.resultMessageId === "string" && !messageIds.has(tool.resultMessageId);
    if (!referencesMissingMessage && !referencesMissingResult) continue;
    delete snapshot.tools[toolId];
    removedToolIds.add(toolId);
  }

  if (removedToolIds.size === 0 || !isRecord(snapshot.facets)) return;
  for (const [facetId, facet] of Object.entries(snapshot.facets)) {
    if (
      isRecord(facet) &&
      isRecord(facet.subject) &&
      facet.subject.type === "tool" &&
      typeof facet.subject.id === "string" &&
      removedToolIds.has(facet.subject.id)
    ) {
      delete snapshot.facets[facetId];
    }
  }
}

function earliestSnapshotTimestamp(snapshot: Record<string, unknown>): number {
  if (!Array.isArray(snapshot.messages)) return 0;
  const timestamps = snapshot.messages.flatMap((entry) => {
    if (!isRecord(entry) || !isRecord(entry.message)) return [];
    const timestamp = entry.message.timestamp;
    return typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0
      ? [timestamp]
      : [];
  });
  return timestamps.length > 0 ? Math.min(...timestamps) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
