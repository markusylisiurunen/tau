import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { SessionProtocolSnapshot } from "../protocol/session_protocol.js";
import { validateSessionProtocolResult } from "../protocol/session_protocol.js";
import {
  assertExpectedSessionRevision,
  type SessionStore,
  type SessionStoreCommitOptions,
  type SessionStoreDeleteOptions,
  validateSessionStoreSnapshot,
} from "./session_store.js";

export type FileSessionStoreOptions = {
  directory: string;
};

const SNAPSHOT_FILE_EXTENSION = ".json";
const SNAPSHOT_LOCK_TIMEOUT_MS = 30_000;
const SNAPSHOT_LOCK_RETRY_MS = 10;

export function getDefaultSessionStoreDirectory(homeDir?: string): string {
  return join(homeDir ?? homedir(), ".config", "tau", "sessions");
}

export class FileSessionStore implements SessionStore {
  private readonly directory: string;

  constructor(options: FileSessionStoreOptions) {
    this.directory = options.directory;
  }

  async commitSessionSnapshot(
    snapshot: SessionProtocolSnapshot,
    options: SessionStoreCommitOptions = {},
  ): Promise<void> {
    const validated = validateSessionStoreSnapshot(snapshot);
    await this.withSnapshotLock(validated.sessionId, async () => {
      const current = await this.loadSessionUnlocked(validated.sessionId);
      assertExpectedSessionRevision(validated.sessionId, options.expectedRevision, current);

      const finalPath = this.snapshotPath(validated.sessionId);
      const tempPath = `${finalPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
      await writeFile(tempPath, `${JSON.stringify(validated)}\n`, "utf8");
      await rename(tempPath, finalPath);
    });
  }

  async loadSession(sessionId: string): Promise<SessionProtocolSnapshot | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.snapshotPath(sessionId), "utf8");
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }

    return parseStoredSnapshot(sessionId, raw);
  }

  async listSessionSnapshots(): Promise<SessionProtocolSnapshot[]> {
    const filenames = await this.snapshotFilenames();
    const snapshots: SessionProtocolSnapshot[] = [];
    for (const filename of filenames) {
      const sessionId = sessionIdFromSnapshotFilename(filename);
      const snapshot = await this.loadSession(sessionId);
      if (snapshot) {
        snapshots.push(snapshot);
      }
    }
    return snapshots;
  }

  async deleteSession(sessionId: string, options: SessionStoreDeleteOptions = {}): Promise<void> {
    await this.withSnapshotLock(sessionId, async () => {
      const current = await this.loadSessionUnlocked(sessionId);
      assertExpectedSessionRevision(sessionId, options.expectedRevision, current);
      await rm(this.snapshotPath(sessionId), { force: true });
    });
  }

  private async loadSessionUnlocked(
    sessionId: string,
  ): Promise<SessionProtocolSnapshot | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.snapshotPath(sessionId), "utf8");
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }

    return parseStoredSnapshot(sessionId, raw);
  }

  private async snapshotFilenames(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch (error) {
      if (isNotFound(error)) {
        return [];
      }
      throw error;
    }

    return entries
      .filter((entry) => entry.endsWith(SNAPSHOT_FILE_EXTENSION))
      .sort((a, b) => a.localeCompare(b));
  }

  private snapshotPath(sessionId: string): string {
    return join(this.directory, snapshotFilename(sessionId));
  }

  private snapshotLockPath(sessionId: string): string {
    return `${this.snapshotPath(sessionId)}.lock`;
  }

  private async withSnapshotLock<T>(sessionId: string, handler: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true });
    const lockPath = this.snapshotLockPath(sessionId);
    const startedAt = Date.now();

    while (true) {
      try {
        await mkdir(lockPath);
        break;
      } catch (error) {
        if (!isAlreadyExists(error)) {
          throw error;
        }
        if (Date.now() - startedAt > SNAPSHOT_LOCK_TIMEOUT_MS) {
          throw new Error(`timed out waiting for stored session snapshot lock: ${sessionId}`);
        }
        await sleep(SNAPSHOT_LOCK_RETRY_MS);
      }
    }

    try {
      return await handler();
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }
}

function parseStoredSnapshot(sessionId: string, raw: string): SessionProtocolSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`stored session snapshot is not valid JSON: ${sessionId}`, { cause: error });
  }

  const snapshot = validateSessionProtocolResult("session.snapshot", parsed);
  if (!snapshot.ok) {
    throw new Error(`stored session snapshot is invalid: ${sessionId}`, {
      cause: new Error(snapshot.error.message),
    });
  }

  if (snapshot.value.sessionId !== sessionId) {
    throw new Error(`stored session snapshot id mismatch: ${sessionId}`);
  }

  return snapshot.value;
}

function snapshotFilename(sessionId: string): string {
  return `${Buffer.from(sessionId, "utf8").toString("base64url")}${SNAPSHOT_FILE_EXTENSION}`;
}

function sessionIdFromSnapshotFilename(filename: string): string {
  const encoded = basename(filename, SNAPSHOT_FILE_EXTENSION);
  return Buffer.from(encoded, "base64url").toString("utf8");
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
