import type { SessionProtocolSnapshot } from "../protocol/session_protocol.js";
import {
  assertExpectedSessionRevision,
  type SessionStore,
  type SessionStoreCommitOptions,
  type SessionStoreDeleteOptions,
  validateSessionStoreSnapshot,
} from "./session_store.js";

export class MemorySessionStore implements SessionStore {
  private readonly snapshots = new Map<string, SessionProtocolSnapshot>();

  async commitSessionSnapshot(
    snapshot: SessionProtocolSnapshot,
    options: SessionStoreCommitOptions = {},
  ): Promise<void> {
    const validated = validateSessionStoreSnapshot(snapshot);
    assertExpectedSessionRevision(
      validated.sessionId,
      options.expectedRevision,
      this.snapshots.get(validated.sessionId),
    );
    this.snapshots.set(validated.sessionId, cloneSessionSnapshot(validated));
  }

  async loadSession(sessionId: string): Promise<SessionProtocolSnapshot | undefined> {
    const snapshot = this.snapshots.get(sessionId);
    return snapshot ? cloneSessionSnapshot(snapshot) : undefined;
  }

  async listSessionSnapshots(): Promise<SessionProtocolSnapshot[]> {
    return [...this.snapshots.values()].map((snapshot) => cloneSessionSnapshot(snapshot));
  }

  async deleteSession(sessionId: string, options: SessionStoreDeleteOptions = {}): Promise<void> {
    assertExpectedSessionRevision(
      sessionId,
      options.expectedRevision,
      this.snapshots.get(sessionId),
    );
    this.snapshots.delete(sessionId);
  }
}

function cloneSessionSnapshot(snapshot: SessionProtocolSnapshot): SessionProtocolSnapshot {
  return structuredClone(snapshot);
}
