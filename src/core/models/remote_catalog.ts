import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
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
const activeRefreshesByPath = new Map<string, Promise<RemoteCatalogRefreshResult>>();

const CostRatesSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
});

const ModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  api: z.string().min(1),
  provider: z.string().min(1),
  baseUrl: z.string().min(1),
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
});

const StoredProviderSchema = z.object({
  models: z.array(ModelSchema),
  checkedAt: z.number().nonnegative(),
  lastModified: z.number().nonnegative().optional(),
  etag: z.string().optional(),
});

const StoreSchema = z.object({
  version: z.literal(CACHE_VERSION),
  providers: z.record(z.string(), StoredProviderSchema),
});

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

type ProviderUpdate = {
  provider: string;
  entry: StoredProvider;
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
  const parsed = StoreSchema.safeParse(JSON.parse(raw) as unknown);
  return parsed.success ? parsed.data : emptyDocument();
}

function readStoreDocument(path: string): StoreDocument {
  try {
    return parseStoreDocument(readFileSync(path, "utf8"));
  } catch {
    return emptyDocument();
  }
}

async function acquireLock(path: string): Promise<() => void> {
  const startedAt = Date.now();
  while (true) {
    try {
      mkdirSync(path, { mode: PRIVATE_DIRECTORY_MODE });
      const ownerPath = join(path, "owner");
      const descriptor = openSync(ownerPath, "wx", PRIVATE_FILE_MODE);
      try {
        writeFileSync(descriptor, `${process.pid}\n`, "utf8");
      } finally {
        closeSync(descriptor);
      }
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

class FileRemoteModelCatalogStore {
  constructor(private readonly path: string) {}

  read(): StoreDocument {
    return readStoreDocument(this.path);
  }

  async apply(updates: readonly ProviderUpdate[]): Promise<StoreDocument> {
    if (updates.length === 0) return this.read();
    mkdirSync(dirname(this.path), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const release = await acquireLock(`${this.path}.lock`);
    try {
      const document = this.read();
      for (const update of updates) {
        document.providers[update.provider] = structuredClone(update.entry);
      }
      saveStoreDocument(this.path, document);
      return document;
    } finally {
      release();
    }
  }
}

function parseProviderCatalog(provider: string, value: unknown): Model<Api>[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid model catalog for provider '${provider}'`);
  }

  const models: Model<Api>[] = [];
  for (const [key, entry] of Object.entries(value)) {
    const parsed = ModelSchema.safeParse(entry);
    if (!parsed.success || parsed.data.id !== key || parsed.data.provider !== provider) {
      throw new Error(`invalid model catalog entry '${provider}/${key}'`);
    }
    models.push(parsed.data as Model<Api>);
  }
  return models;
}

function activeModels(
  entry: StoredProvider | undefined,
  builtinGeneratedAt: number | undefined,
): readonly Model<Api>[] {
  if (!entry) return [];
  if (
    builtinGeneratedAt !== undefined &&
    (entry.lastModified === undefined || entry.lastModified <= builtinGeneratedAt)
  ) {
    return [];
  }
  return entry.models as unknown as readonly Model<Api>[];
}

function createSnapshot(
  document: StoreDocument,
  builtinGeneratedAt: number | undefined,
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
  private readonly builtinGeneratedAt: number | undefined;
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly refreshIntervalMs: number;

  constructor(options: RemoteModelCatalogOptions) {
    this.path = options.path;
    this.store = new FileRemoteModelCatalogStore(options.path);
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.providerIds = options.providerIds ?? getDefaultProviderIds();
    this.builtinGeneratedAt = options.builtinGeneratedAt ?? getBuiltinModelDataGeneratedAt();
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
    const active = activeRefreshesByPath.get(this.path);
    if (active) return active;
    const operation = this.runRefresh(options).finally(() => {
      if (activeRefreshesByPath.get(this.path) === operation) {
        activeRefreshesByPath.delete(this.path);
      }
    });
    activeRefreshesByPath.set(this.path, operation);
    return operation;
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
          return { provider, entry: { ...entry, checkedAt } };
        }
        if (!response.ok) {
          throw new Error(`model catalog request failed with status ${response.status}`);
        }
        const refreshed = parseProviderCatalog(provider, await response.json());
        const parsedLastModified = Date.parse(response.headers.get("last-modified") ?? "");
        const nextEntry: StoredProvider = {
          models: refreshed,
          checkedAt,
          lastModified: Number.isNaN(parsedLastModified) ? 0 : parsedLastModified,
          ...(response.headers.get("etag")
            ? { etag: response.headers.get("etag") ?? undefined }
            : {}),
        };
        results.set(provider, { status: "updated", modelCount: refreshed.length });
        return { provider, entry: nextEntry };
      } catch (error) {
        results.set(provider, { status: "failed", error: formatError(error) });
        return undefined;
      }
    });

    const document = await this.store.apply(
      updates.filter((update): update is ProviderUpdate => update !== undefined),
    );
    return {
      providers: results,
      snapshot: createSnapshot(document, this.builtinGeneratedAt),
    };
  }
}
