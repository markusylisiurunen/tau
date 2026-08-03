import type { SessionProtocolSnapshot } from "../protocol/session_protocol.js";
import { validateSessionProtocolResult } from "../protocol/session_protocol.js";

export const STORED_SESSION_DOCUMENT_FORMAT = "tau-session" as const;
export const STORED_SESSION_DOCUMENT_VERSION = 5 as const;
export const LEGACY_SESSION_CONTEXT_EPOCH = "legacy-v3";

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
      contextEpoch: LEGACY_SESSION_CONTEXT_EPOCH,
    };
  }
  removeLegacyPruningPresentation(snapshot);
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
