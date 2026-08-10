import type { SessionProtocolSnapshot } from "../protocol/session_protocol.js";
import { validateSessionProtocolResult } from "../protocol/session_protocol.js";

export type SessionStoreCommitOptions = {
  expectedRevision?: number;
};

export interface SessionStore {
  commitSessionSnapshot(
    snapshot: SessionProtocolSnapshot,
    options?: SessionStoreCommitOptions,
  ): Promise<void>;
  loadSession(sessionId: string): Promise<SessionProtocolSnapshot | undefined>;
  listSessionSnapshots(): Promise<SessionProtocolSnapshot[]>;
}

export class SessionStoreConflictError extends Error {
  constructor(
    readonly sessionId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `stored session snapshot revision conflict for ${sessionId}: expected ${expectedRevision}, found ${actualRevision}`,
    );
    this.name = "SessionStoreConflictError";
  }
}

export function validateSessionStoreSnapshot(
  snapshot: SessionProtocolSnapshot,
): SessionProtocolSnapshot {
  const parsed = validateSessionProtocolResult("session.snapshot", snapshot);
  if (!parsed.ok) {
    throw new Error("session snapshot is invalid", {
      cause: new Error(parsed.error.message),
    });
  }

  return parsed.value;
}

export function assertExpectedSessionRevision(
  sessionId: string,
  expectedRevision: number | undefined,
  current: SessionProtocolSnapshot | undefined,
): void {
  if (expectedRevision === undefined) {
    return;
  }

  const actualRevision = current?.revision ?? 0;
  if (actualRevision !== expectedRevision) {
    throw new SessionStoreConflictError(sessionId, expectedRevision, actualRevision);
  }
}
