import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
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

type SnapshotLockOwner = {
  pid: number;
  token: string;
  createdAt: number;
};

const SNAPSHOT_FILE_EXTENSION = ".json";
const SNAPSHOT_TEMP_FILE_PATTERN =
  /^([A-Za-z0-9_-]+\.json)\.(\d+)\.(\d+)\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.tmp$/;
const SNAPSHOT_LOCK_OWNER_FILENAME = "owner.json";
const SNAPSHOT_LOCK_TIMEOUT_MS = 30_000;
const SNAPSHOT_LOCK_RETRY_MS = 10;
const SNAPSHOT_INCOMPLETE_LOCK_STALE_MS = 1_000;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export function getDefaultSessionStoreDirectory(homeDir?: string): string {
  return join(homeDir ?? homedir(), ".config", "tau", "sessions");
}

export class FileSessionStore implements SessionStore {
  private readonly directory: string;
  private initialization?: Promise<void>;

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
      try {
        await writeFile(tempPath, `${JSON.stringify(validated)}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: PRIVATE_FILE_MODE,
        });
        await rename(tempPath, finalPath);
        await chmod(finalPath, PRIVATE_FILE_MODE);
      } finally {
        await rm(tempPath, { force: true });
      }
    });
  }

  async loadSession(sessionId: string): Promise<SessionProtocolSnapshot | undefined> {
    await this.ensureInitialized();
    return await this.loadSessionUnlocked(sessionId);
  }

  async listSessionSnapshots(): Promise<SessionProtocolSnapshot[]> {
    await this.ensureInitialized();
    const filenames = await this.snapshotFilenames();
    const snapshots: SessionProtocolSnapshot[] = [];
    for (const filename of filenames) {
      const sessionId = sessionIdFromSnapshotFilename(filename);
      const snapshot = await this.loadSessionUnlocked(sessionId);
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
      await this.cleanupSessionTemporaryFiles(sessionId);
    });
  }

  private async ensureInitialized(): Promise<void> {
    await this.ensureDirectoryPermissions();
    if (!this.initialization) {
      this.initialization = this.initialize().catch((error) => {
        this.initialization = undefined;
        throw error;
      });
    }
    await this.initialization;
  }

  private async initialize(): Promise<void> {
    const entries = await readdir(this.directory);
    const sessionIds = new Set<string>();
    for (const entry of entries) {
      const sessionId = sessionIdFromSnapshotTempFilename(entry);
      if (sessionId !== undefined) {
        sessionIds.add(sessionId);
      }
    }

    for (const sessionId of sessionIds) {
      await this.withSnapshotLockRaw(sessionId, () => this.cleanupSessionTemporaryFiles(sessionId));
    }
  }

  private async ensureDirectoryPermissions(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await chmod(this.directory, PRIVATE_DIRECTORY_MODE);
  }

  private async loadSessionUnlocked(
    sessionId: string,
  ): Promise<SessionProtocolSnapshot | undefined> {
    const path = this.snapshotPath(sessionId);
    let raw: string;
    try {
      await chmod(path, PRIVATE_FILE_MODE);
      raw = await readFile(path, "utf8");
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }

    return parseStoredSnapshot(sessionId, raw);
  }

  private async snapshotFilenames(): Promise<string[]> {
    const entries = await readdir(this.directory);
    return entries.filter((entry) => isSnapshotFilename(entry)).sort((a, b) => a.localeCompare(b));
  }

  private snapshotPath(sessionId: string): string {
    return join(this.directory, snapshotFilename(sessionId));
  }

  private snapshotLockPath(sessionId: string): string {
    return `${this.snapshotPath(sessionId)}.lock`;
  }

  private async cleanupSessionTemporaryFiles(sessionId: string): Promise<void> {
    const expectedSnapshotFilename = snapshotFilename(sessionId);
    const entries = await readdir(this.directory);
    for (const entry of entries) {
      const match = SNAPSHOT_TEMP_FILE_PATTERN.exec(entry);
      if (!match || match[1] !== expectedSnapshotFilename) {
        continue;
      }
      const path = join(this.directory, entry);
      const metadata = await lstat(path).catch((error) => {
        if (isNotFound(error)) return undefined;
        throw error;
      });
      if (!metadata?.isFile() || !isOwnedByCurrentUser(metadata.uid)) {
        continue;
      }
      await rm(path, { force: true });
    }
  }

  private async withSnapshotLock<T>(sessionId: string, handler: () => Promise<T>): Promise<T> {
    await this.ensureInitialized();
    return await this.withSnapshotLockRaw(sessionId, async () => {
      await this.cleanupSessionTemporaryFiles(sessionId);
      return await handler();
    });
  }

  private async withSnapshotLockRaw<T>(sessionId: string, handler: () => Promise<T>): Promise<T> {
    await this.ensureDirectoryPermissions();
    const lockPath = this.snapshotLockPath(sessionId);
    const owner = await acquireSnapshotLock(lockPath, sessionId);
    try {
      return await handler();
    } finally {
      await releaseSnapshotLock(lockPath, owner);
    }
  }
}

async function acquireSnapshotLock(
  lockPath: string,
  sessionId: string,
): Promise<SnapshotLockOwner> {
  const owner: SnapshotLockOwner = {
    pid: process.pid,
    token: randomUUID(),
    createdAt: Date.now(),
  };
  const candidatePath = `${lockPath}.candidate.${owner.token}`;
  const startedAt = Date.now();

  try {
    await mkdir(candidatePath, { mode: PRIVATE_DIRECTORY_MODE });
    await chmod(candidatePath, PRIVATE_DIRECTORY_MODE);
    const ownerPath = join(candidatePath, SNAPSHOT_LOCK_OWNER_FILENAME);
    await writeFile(ownerPath, JSON.stringify(owner), {
      encoding: "utf8",
      flag: "wx",
      mode: PRIVATE_FILE_MODE,
    });
    await chmod(ownerPath, PRIVATE_FILE_MODE);

    while (true) {
      try {
        await rename(candidatePath, lockPath);
        return owner;
      } catch (error) {
        if (!isLockExists(error)) {
          throw error;
        }
        if (await recoverStaleSnapshotLock(lockPath)) {
          continue;
        }
        if (Date.now() - startedAt >= SNAPSHOT_LOCK_TIMEOUT_MS) {
          throw new Error(`timed out waiting for stored session snapshot lock: ${sessionId}`);
        }
        await sleep(SNAPSHOT_LOCK_RETRY_MS);
      }
    }
  } finally {
    await rm(candidatePath, { recursive: true, force: true });
  }
}

async function recoverStaleSnapshotLock(lockPath: string): Promise<boolean> {
  const owner = await readSnapshotLockOwner(lockPath);
  if (owner) {
    if (isProcessAlive(owner.pid)) {
      return false;
    }
    return await quarantineStaleSnapshotLock(lockPath);
  }

  let lockStat: Stats;
  try {
    lockStat = await stat(lockPath);
  } catch (error) {
    if (isNotFound(error)) {
      return true;
    }
    throw error;
  }
  if (Date.now() - lockStat.mtimeMs < SNAPSHOT_INCOMPLETE_LOCK_STALE_MS) {
    return false;
  }
  return await quarantineStaleSnapshotLock(lockPath);
}

async function quarantineStaleSnapshotLock(lockPath: string): Promise<boolean> {
  const stalePath = `${lockPath}.stale.${randomUUID()}`;
  try {
    await rename(lockPath, stalePath);
  } catch (error) {
    if (isNotFound(error)) {
      return true;
    }
    throw error;
  }
  await rm(stalePath, { recursive: true, force: true });
  return true;
}

async function releaseSnapshotLock(
  lockPath: string,
  expectedOwner: SnapshotLockOwner,
): Promise<void> {
  const owner = await readSnapshotLockOwner(lockPath);
  if (owner?.token !== expectedOwner.token) {
    return;
  }
  await rm(lockPath, { recursive: true, force: true });
}

async function readSnapshotLockOwner(lockPath: string): Promise<SnapshotLockOwner | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(lockPath, SNAPSHOT_LOCK_OWNER_FILENAME), "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }

  try {
    const value = JSON.parse(raw) as Partial<SnapshotLockOwner>;
    if (
      !Number.isInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      typeof value.token !== "string" ||
      value.token.length === 0 ||
      typeof value.createdAt !== "number" ||
      !Number.isFinite(value.createdAt)
    ) {
      return undefined;
    }
    return value as SnapshotLockOwner;
  } catch {
    return undefined;
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

function isSnapshotFilename(filename: string): boolean {
  if (!filename.endsWith(SNAPSHOT_FILE_EXTENSION)) {
    return false;
  }
  const sessionId = sessionIdFromSnapshotFilename(filename);
  return snapshotFilename(sessionId) === filename;
}

function snapshotFilename(sessionId: string): string {
  return `${Buffer.from(sessionId, "utf8").toString("base64url")}${SNAPSHOT_FILE_EXTENSION}`;
}

function sessionIdFromSnapshotFilename(filename: string): string {
  const encoded = basename(filename, SNAPSHOT_FILE_EXTENSION);
  return Buffer.from(encoded, "base64url").toString("utf8");
}

function sessionIdFromSnapshotTempFilename(filename: string): string | undefined {
  const match = SNAPSHOT_TEMP_FILE_PATTERN.exec(filename);
  if (!match?.[1]) {
    return undefined;
  }
  const sessionId = sessionIdFromSnapshotFilename(match[1]);
  return snapshotFilename(sessionId) === match[1] ? sessionId : undefined;
}

function isOwnedByCurrentUser(uid: number): boolean {
  return typeof process.getuid !== "function" || uid === process.getuid();
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      (error.code === "ESRCH" || error.code === "EINVAL")
    );
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isLockExists(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "EEXIST" || error.code === "ENOTEMPTY")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
