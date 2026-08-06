import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type { AuthStorageData } from "./types.js";

const invalidAuthStorageFormatReason =
  'auth.json format has changed. please run "tau auth login codex" to re-authenticate.';

const nonEmptyStringSchema = z.string().refine((value) => value.trim().length > 0);
const finiteNumberSchema = z.number().finite();

const authStorageDataSchema = z
  .object({
    providers: z.record(
      z.string().refine((value) => value.trim().length > 0),
      z
        .object({
          accounts: z.array(
            z.discriminatedUnion("type", [
              z
                .object({
                  type: z.literal("oauth"),
                  accountId: nonEmptyStringSchema,
                  disabled: z.boolean().default(false),
                  providerAccountId: nonEmptyStringSchema.optional(),
                  access: nonEmptyStringSchema,
                  refresh: nonEmptyStringSchema,
                  expires: finiteNumberSchema,
                  enterpriseUrl: nonEmptyStringSchema.optional(),
                  projectId: nonEmptyStringSchema.optional(),
                  usage: z
                    .object({
                      windows: z.array(
                        z
                          .object({
                            name: nonEmptyStringSchema,
                            usedPercent: finiteNumberSchema,
                            resetAt: finiteNumberSchema,
                            windowSeconds: finiteNumberSchema,
                          })
                          .passthrough(),
                      ),
                    })
                    .passthrough()
                    .optional(),
                })
                .passthrough(),
              z
                .object({
                  type: z.literal("api_key"),
                  accountId: nonEmptyStringSchema,
                  key: nonEmptyStringSchema,
                })
                .passthrough(),
            ]),
          ),
        })
        .passthrough(),
    ),
  })
  .passthrough();

type AuthLockOwner = {
  pid: number;
  token: string;
  createdAt: number;
};

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const AUTH_LOCK_OWNER_FILENAME = "owner.json";
const AUTH_LOCK_TIMEOUT_MS = 30_000;
const AUTH_LOCK_RETRY_MS = 10;
const AUTH_INCOMPLETE_LOCK_STALE_MS = 1_000;
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export class AuthStorage {
  private data: AuthStorageData = { providers: {} };
  private invalidReason: string | undefined;
  private readonly authDirectory: string;
  private readonly lockPath: string;
  private readonly tempFilePattern: RegExp;

  constructor(private readonly authPath: string) {
    this.authDirectory = dirname(authPath);
    this.lockPath = `${authPath}.lock`;
    this.tempFilePattern = new RegExp(
      `^${RegExp.escape(basename(authPath))}\\.${UUID_PATTERN}\\.tmp$`,
    );
    this.reload();
  }

  reload(): void {
    try {
      this.withLock(() => {
        this.cleanupTemporaryFiles();
        this.loadUnlocked();
      });
    } catch (error) {
      this.data = { providers: {} };
      this.invalidReason = `failed to load auth.json: ${formatError(error)}`;
    }
  }

  getData(): AuthStorageData {
    return this.data;
  }

  update<T>(mutator: (data: AuthStorageData) => T): T {
    return this.withLock(() => {
      this.cleanupTemporaryFiles();
      this.loadUnlocked();
      const result = mutator(this.data);
      this.invalidReason = undefined;
      this.saveUnlocked();
      return result;
    });
  }

  getInvalidReason(): string | undefined {
    return this.invalidReason;
  }

  private loadUnlocked(): void {
    if (!existsSync(this.authPath)) {
      this.data = { providers: {} };
      this.invalidReason = undefined;
      return;
    }

    const metadata = lstatSync(this.authPath);
    assertSafeStorageEntry(this.authPath, metadata, "file");
    chmodSync(this.authPath, PRIVATE_FILE_MODE);

    try {
      const parsed = JSON.parse(readFileSync(this.authPath, "utf8")) as unknown;
      const validated = validateAuthStorageData(parsed);
      this.data = validated.data;
      this.invalidReason = validated.invalidReason;
    } catch (error) {
      this.data = { providers: {} };
      this.invalidReason = `failed to parse auth.json: ${formatError(error)}`;
    }
  }

  private saveUnlocked(): void {
    const tmpPath = `${this.authPath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), {
        encoding: "utf8",
        flag: "wx",
        mode: PRIVATE_FILE_MODE,
      });
      renameSync(tmpPath, this.authPath);
      chmodSync(this.authPath, PRIVATE_FILE_MODE);
    } finally {
      rmSync(tmpPath, { force: true });
    }
  }

  private cleanupTemporaryFiles(): void {
    for (const entry of readdirSync(this.authDirectory)) {
      if (!this.tempFilePattern.test(entry)) {
        continue;
      }
      const path = join(this.authDirectory, entry);
      let metadata: Stats;
      try {
        metadata = lstatSync(path);
      } catch (error) {
        if (isNotFound(error)) continue;
        throw error;
      }
      if (!metadata.isFile() || !isOwnedByCurrentUser(metadata.uid)) {
        continue;
      }
      rmSync(path, { force: true });
    }
  }

  private withLock<T>(handler: () => T): T {
    ensureSecureDirectory(this.authDirectory);
    const owner = acquireAuthLock(this.lockPath);
    try {
      return handler();
    } finally {
      releaseAuthLock(this.lockPath, owner);
    }
  }
}

function ensureSecureDirectory(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  }
  const metadata = lstatSync(path);
  assertSafeStorageEntry(path, metadata, "directory");
  chmodSync(path, PRIVATE_DIRECTORY_MODE);
}

function assertSafeStorageEntry(path: string, metadata: Stats, type: "file" | "directory"): void {
  const matchesType = type === "file" ? metadata.isFile() : metadata.isDirectory();
  if (metadata.isSymbolicLink() || !matchesType) {
    throw new Error(`auth storage ${type} is not a regular ${type}: ${path}`);
  }
  if (!isOwnedByCurrentUser(metadata.uid)) {
    throw new Error(`auth storage ${type} is not owned by the current user: ${path}`);
  }
}

function acquireAuthLock(lockPath: string): AuthLockOwner {
  const owner: AuthLockOwner = {
    pid: process.pid,
    token: randomUUID(),
    createdAt: Date.now(),
  };
  const candidatePath = `${lockPath}.candidate.${owner.token}`;
  const startedAt = Date.now();

  try {
    mkdirSync(candidatePath, { mode: PRIVATE_DIRECTORY_MODE });
    chmodSync(candidatePath, PRIVATE_DIRECTORY_MODE);
    const ownerPath = join(candidatePath, AUTH_LOCK_OWNER_FILENAME);
    writeFileSync(ownerPath, JSON.stringify(owner), {
      encoding: "utf8",
      flag: "wx",
      mode: PRIVATE_FILE_MODE,
    });
    chmodSync(ownerPath, PRIVATE_FILE_MODE);

    while (true) {
      try {
        renameSync(candidatePath, lockPath);
        return owner;
      } catch (error) {
        if (!isLockExists(error)) {
          throw error;
        }
        if (recoverStaleAuthLock(lockPath)) {
          continue;
        }
        if (Date.now() - startedAt >= AUTH_LOCK_TIMEOUT_MS) {
          throw new Error("timed out waiting for auth storage lock");
        }
        sleepSync(AUTH_LOCK_RETRY_MS);
      }
    }
  } finally {
    rmSync(candidatePath, { recursive: true, force: true });
  }
}

function recoverStaleAuthLock(lockPath: string): boolean {
  const owner = readAuthLockOwner(lockPath);
  if (owner) {
    if (isProcessAlive(owner.pid)) {
      return false;
    }
    return quarantineStaleAuthLock(lockPath);
  }

  let lockStat: Stats;
  try {
    lockStat = statSync(lockPath);
  } catch (error) {
    if (isNotFound(error)) {
      return true;
    }
    throw error;
  }
  if (Date.now() - lockStat.mtimeMs < AUTH_INCOMPLETE_LOCK_STALE_MS) {
    return false;
  }
  return quarantineStaleAuthLock(lockPath);
}

function quarantineStaleAuthLock(lockPath: string): boolean {
  const stalePath = `${lockPath}.stale.${randomUUID()}`;
  try {
    renameSync(lockPath, stalePath);
  } catch (error) {
    if (isNotFound(error)) {
      return true;
    }
    throw error;
  }
  rmSync(stalePath, { recursive: true, force: true });
  return true;
}

function releaseAuthLock(lockPath: string, expectedOwner: AuthLockOwner): void {
  const owner = readAuthLockOwner(lockPath);
  if (owner?.token !== expectedOwner.token) {
    return;
  }
  rmSync(lockPath, { recursive: true, force: true });
}

function readAuthLockOwner(lockPath: string): AuthLockOwner | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(lockPath, AUTH_LOCK_OWNER_FILENAME), "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }

  try {
    const value = JSON.parse(raw) as Partial<AuthLockOwner>;
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
    return value as AuthLockOwner;
  } catch {
    return undefined;
  }
}

function validateAuthStorageData(value: unknown): {
  data: AuthStorageData;
  invalidReason?: string;
} {
  const parsed = authStorageDataSchema.safeParse(value);
  if (!parsed.success) {
    return invalidAuthStorage();
  }

  return {
    data: parsed.data,
  };
}

function invalidAuthStorage(): { data: AuthStorageData; invalidReason: string } {
  return { data: { providers: {} }, invalidReason: invalidAuthStorageFormatReason };
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

function sleepSync(ms: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(signal, 0, 0, ms);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
