import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  getBuiltinModelDataGeneratedAt,
  getBuiltinModels,
  getBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all";
import { z } from "zod";
import { PI_AI_VERSION } from "../version.js";

const CACHE_VERSION = 1;
const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const REFRESH_CONCURRENCY = 6;
const LOCK_TIMEOUT_MS = 30_000;
const LOCK_RETRY_MS = 20;
const LOCK_STALE_MS = 60_000;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const activeRefreshesByPath = new Map<string, ActiveRemoteCatalogRefresh>();

const CostRatesSchema = z
  .object({
    input: z.number().finite(),
    output: z.number().finite(),
    cacheRead: z.number().finite(),
    cacheWrite: z.number().finite(),
  })
  .passthrough();

const ModelSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    api: z.string().min(1),
    provider: z.string().min(1),
    baseUrl: z.string(),
    reasoning: z.boolean(),
    thinkingLevelMap: z.record(z.string(), z.string().nullable()).optional(),
    input: z.array(z.enum(["text", "image"])),
    cost: CostRatesSchema.extend({
      tiers: z
        .array(
          CostRatesSchema.extend({
            inputTokensAbove: z.number().int().nonnegative(),
          }),
        )
        .optional(),
    }),
    contextWindow: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
    samplingParams: z.record(z.string(), z.unknown()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    compat: z.unknown().optional(),
  })
  .passthrough();

const StoredProviderSchema = z.object({
  models: z.array(ModelSchema),
  checkedAt: z.number().nonnegative(),
  lastModified: z.number().nonnegative(),
  etag: z.string().optional(),
});

const StoreSchema = z.object({
  version: z.literal(CACHE_VERSION),
  providers: z.record(z.string(), StoredProviderSchema),
});

type StoredModel = z.infer<typeof ModelSchema>;
type StoredProvider = z.infer<typeof StoredProviderSchema>;
type StoreDocument = z.infer<typeof StoreSchema>;

export type RemoteModelCatalogSnapshot = ReadonlyMap<string, readonly Model<Api>[]>;

export type RemoteCatalogProviderResult =
  | { status: "updated"; modelCount: number }
  | { status: "unchanged"; modelCount: number }
  | { status: "fresh"; modelCount: number }
  | { status: "failed"; error: Error };

export type RemoteCatalogRefreshResult = {
  providers: ReadonlyMap<string, RemoteCatalogProviderResult>;
  snapshot: RemoteModelCatalogSnapshot;
};

type ActiveRemoteCatalogRefresh = {
  controller: AbortController;
  consumers: Set<symbol>;
  promise: Promise<RemoteCatalogRefreshResult>;
};

type ProviderUpdate =
  | {
      type: "revalidate";
      provider: string;
      expected: StoredProvider;
      checkedAt: number;
    }
  | {
      type: "replace";
      provider: string;
      expected: StoredProvider | undefined;
      entry: StoredProvider;
    };

type StoreApplyResult = {
  document: StoreDocument;
  skippedProviders: ReadonlySet<string>;
};

export function getDefaultModelCatalogStorePath(home: string): string {
  return join(home, ".config", "tau", "models-store.json");
}

function cloneModel(model: Model<Api>): Model<Api> {
  return structuredClone(model);
}

function emptyDocument(): StoreDocument {
  return { version: CACHE_VERSION, providers: {} };
}

function parseStoreDocument(raw: string): StoreDocument {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return emptyDocument();
  }
  const parsed = StoreSchema.safeParse(value);
  return parsed.success ? parsed.data : emptyDocument();
}

function readStoreDocument(path: string): StoreDocument {
  try {
    return parseStoreDocument(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyDocument();
    }
    throw error;
  }
}

async function acquireLock(path: string): Promise<() => void> {
  const startedAt = Date.now();
  while (true) {
    try {
      mkdirSync(path, { mode: PRIVATE_DIRECTORY_MODE });
      return () => rmSync(path, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(path).mtimeMs >= LOCK_STALE_MS) {
          rmSync(path, { recursive: true, force: true });
          continue;
        }
      } catch {}
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new Error(`timed out waiting for model catalog store lock '${path}'`);
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}

function saveStoreDocument(path: string, document: StoreDocument): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  chmodSync(directory, PRIVATE_DIRECTORY_MODE);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: PRIVATE_FILE_MODE,
    });
    renameSync(temporaryPath, path);
    chmodSync(path, PRIVATE_FILE_MODE);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function hasSameProviderRevision(
  current: StoredProvider | undefined,
  expected: StoredProvider | undefined,
): boolean {
  return (
    current?.checkedAt === expected?.checkedAt &&
    current?.lastModified === expected?.lastModified &&
    current?.etag === expected?.etag
  );
}

class FileRemoteModelCatalogStore {
  constructor(private readonly path: string) {}

  read(): StoreDocument {
    return readStoreDocument(this.path);
  }

  async apply(updates: readonly ProviderUpdate[]): Promise<StoreApplyResult> {
    if (updates.length === 0) {
      return { document: this.read(), skippedProviders: new Set() };
    }
    mkdirSync(dirname(this.path), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const release = await acquireLock(`${this.path}.lock`);
    try {
      const document = this.read();
      const skippedProviders = new Set<string>();
      let changed = false;
      for (const update of updates) {
        const current = document.providers[update.provider];
        if (!hasSameProviderRevision(current, update.expected)) {
          const incomingIsNewer =
            update.type === "replace" &&
            current !== undefined &&
            update.entry.lastModified > current.lastModified;
          if (!incomingIsNewer) {
            skippedProviders.add(update.provider);
            continue;
          }
        }
        document.providers[update.provider] =
          update.type === "replace"
            ? structuredClone(update.entry)
            : { ...structuredClone(current!), checkedAt: update.checkedAt };
        changed = true;
      }
      if (changed) saveStoreDocument(this.path, document);
      return { document, skippedProviders };
    } finally {
      release();
    }
  }
}

function parseProviderCatalog(provider: string, value: unknown): StoredModel[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid model catalog for provider '${provider}'`);
  }

  const models: StoredModel[] = [];
  for (const [key, entry] of Object.entries(value)) {
    const parsed = ModelSchema.safeParse(entry);
    if (!parsed.success || parsed.data.id !== key || parsed.data.provider !== provider) {
      throw new Error(`invalid model catalog entry '${provider}/${key}'`);
    }
    models.push(parsed.data);
  }
  return models;
}

function activeModels(
  entry: StoredProvider | undefined,
  builtinGeneratedAt: number,
): readonly Model<Api>[] {
  if (!entry || entry.lastModified <= builtinGeneratedAt) return [];
  return entry.models as unknown as readonly Model<Api>[];
}

function createSnapshot(
  document: StoreDocument,
  builtinGeneratedAt: number,
): RemoteModelCatalogSnapshot {
  const snapshot = new Map<string, readonly Model<Api>[]>();
  for (const [provider, entry] of Object.entries(document.providers)) {
    const models = activeModels(entry, builtinGeneratedAt);
    if (models.length > 0) snapshot.set(provider, models.map(cloneModel));
  }
  return snapshot;
}

function getDefaultProviderIds(): string[] {
  return getBuiltinProviders().filter((provider) => getBuiltinModels(provider).length > 0);
}

function getUserAgent(): string {
  return `pi/${PI_AI_VERSION} (${process.platform}; node/${process.version}; ${process.arch})`;
}

function formatError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

async function mapConcurrent<T>(
  values: readonly string[],
  concurrency: number,
  worker: (value: string) => Promise<T>,
): Promise<T[]> {
  const results = new Array<T>(values.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++;
        results[index] = await worker(values[index]!);
      }
    }),
  );
  return results;
}

export type RemoteModelCatalogOptions = {
  path: string;
  fetch?: typeof fetch;
  now?: () => number;
  providerIds?: readonly string[];
  builtinGeneratedAt?: number;
  baseUrl?: string;
  requestTimeoutMs?: number;
  refreshIntervalMs?: number;
};

export class RemoteModelCatalog {
  private readonly path: string;
  private readonly store: FileRemoteModelCatalogStore;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly providerIds: readonly string[];
  private readonly builtinGeneratedAt: number;
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly refreshIntervalMs: number;

  constructor(options: RemoteModelCatalogOptions) {
    this.path = options.path;
    this.store = new FileRemoteModelCatalogStore(options.path);
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.providerIds = options.providerIds ?? getDefaultProviderIds();
    const builtinGeneratedAt = options.builtinGeneratedAt ?? getBuiltinModelDataGeneratedAt();
    if (builtinGeneratedAt === undefined) {
      throw new Error("pi-ai built-in model catalog is missing its generation timestamp");
    }
    this.builtinGeneratedAt = builtinGeneratedAt;
    this.baseUrl = options.baseUrl ?? "https://pi.dev";
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.refreshIntervalMs = options.refreshIntervalMs ?? REFRESH_INTERVAL_MS;
  }

  snapshot(): RemoteModelCatalogSnapshot {
    return createSnapshot(this.store.read(), this.builtinGeneratedAt);
  }

  refresh(
    options: { force?: boolean; signal?: AbortSignal } = {},
  ): Promise<RemoteCatalogRefreshResult> {
    let active = activeRefreshesByPath.get(this.path);
    if (!active) {
      const controller = new AbortController();
      let created: ActiveRemoteCatalogRefresh;
      const promise = this.runRefresh({ force: options.force, signal: controller.signal }).finally(
        () => {
          if (activeRefreshesByPath.get(this.path) === created) {
            activeRefreshesByPath.delete(this.path);
          }
        },
      );
      created = { controller, consumers: new Set(), promise };
      activeRefreshesByPath.set(this.path, created);
      active = created;
    }
    return this.observeRefresh(active, options.signal);
  }

  private observeRefresh(
    active: ActiveRemoteCatalogRefresh,
    signal: AbortSignal | undefined,
  ): Promise<RemoteCatalogRefreshResult> {
    const consumer = Symbol();
    active.consumers.add(consumer);
    let released = false;
    const release = (): boolean => {
      if (released) return false;
      released = true;
      active.consumers.delete(consumer);
      if (
        active.consumers.size === 0 &&
        activeRefreshesByPath.get(this.path) === active &&
        !active.controller.signal.aborted
      ) {
        active.controller.abort();
        return true;
      }
      return false;
    };

    if (!signal) {
      return active.promise.finally(() => {
        release();
      });
    }

    return new Promise((resolve, reject) => {
      const rejectAfterRelease = () => {
        const abortedOperation = release();
        const rejectWithReason = () => reject(signal.reason);
        if (abortedOperation) {
          void active.promise.then(rejectWithReason, rejectWithReason);
        } else {
          rejectWithReason();
        }
      };
      if (signal.aborted) {
        rejectAfterRelease();
        return;
      }

      const onAbort = () => rejectAfterRelease();
      signal.addEventListener("abort", onAbort, { once: true });
      void active.promise.then(
        (result) => {
          if (released) return;
          signal.removeEventListener("abort", onAbort);
          release();
          resolve(result);
        },
        (error) => {
          if (released) return;
          signal.removeEventListener("abort", onAbort);
          release();
          reject(error);
        },
      );
    });
  }

  private async runRefresh(options: {
    force?: boolean;
    signal?: AbortSignal;
  }): Promise<RemoteCatalogRefreshResult> {
    const stored = this.store.read();
    const results = new Map<string, RemoteCatalogProviderResult>();
    const updates = await mapConcurrent(this.providerIds, REFRESH_CONCURRENCY, async (provider) => {
      const entry = stored.providers[provider];
      const models = activeModels(entry, this.builtinGeneratedAt);
      if (
        !options.force &&
        entry?.checkedAt !== undefined &&
        this.now() - entry.checkedAt < this.refreshIntervalMs
      ) {
        results.set(provider, { status: "fresh", modelCount: models.length });
        return undefined;
      }

      try {
        options.signal?.throwIfAborted();
        const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
        const signal = options.signal
          ? AbortSignal.any([options.signal, timeoutSignal])
          : timeoutSignal;
        const response = await this.fetch(
          new URL(`/api/models/providers/${encodeURIComponent(provider)}`, this.baseUrl),
          {
            headers: {
              accept: "application/json",
              "User-Agent": getUserAgent(),
              ...(entry?.models.length && entry.etag ? { "If-None-Match": entry.etag } : {}),
            },
            signal,
          },
        );
        const checkedAt = this.now();
        if (response.status === 304 && entry) {
          results.set(provider, { status: "unchanged", modelCount: models.length });
          return { type: "revalidate" as const, provider, expected: entry, checkedAt };
        }
        if (!response.ok) {
          throw new Error(`model catalog request failed with status ${response.status}`);
        }
        const refreshed = parseProviderCatalog(provider, await response.json());
        const lastModified = Date.parse(response.headers.get("last-modified") ?? "");
        if (Number.isNaN(lastModified) || lastModified < 0) {
          throw new Error("model catalog response is missing a valid Last-Modified header");
        }
        const etag = response.headers.get("etag");
        const nextEntry: StoredProvider = {
          models: refreshed,
          checkedAt,
          lastModified,
          ...(etag ? { etag } : {}),
        };
        results.set(provider, { status: "updated", modelCount: refreshed.length });
        return { type: "replace" as const, provider, expected: entry, entry: nextEntry };
      } catch (error) {
        results.set(provider, { status: "failed", error: formatError(error) });
        return undefined;
      }
    });

    const applied = await this.store.apply(
      updates.filter((update): update is ProviderUpdate => update !== undefined),
    );
    for (const provider of applied.skippedProviders) {
      const models = activeModels(applied.document.providers[provider], this.builtinGeneratedAt);
      results.set(provider, { status: "unchanged", modelCount: models.length });
    }
    return {
      providers: results,
      snapshot: createSnapshot(applied.document, this.builtinGeneratedAt),
    };
  }
}
