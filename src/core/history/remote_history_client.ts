import { z } from "zod";
import { formatZodError } from "../utils/zod.js";
import type {
  HistoryQuery,
  HistoryReadInput,
  HistoryReadResult,
  HistoryRemoteTarget,
  HistoryReplicationOperation,
  HistorySearchInput,
  HistorySearchResult,
} from "./types.js";

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export class RemoteHistoryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "RemoteHistoryError";
  }
}

const digestSchema = z
  .object({
    title: z.string(),
    summary: z.string(),
    updatedThroughEntryId: z.string(),
  })
  .strict();
const descriptorSchema = z
  .object({
    sessionId: z.string(),
    attributes: z.record(z.string(), z.string()),
    createdAt: z.number(),
    updatedAt: z.number(),
    digest: digestSchema.optional(),
    snippets: z.array(z.string()),
  })
  .strict();
const jsonValueSchema = z.union([
  z.null(),
  z.boolean(),
  z.number(),
  z.string(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);
const entryBaseSchema = z.object({
  id: z.string(),
  sourceIds: z.array(z.string()),
  timestamp: z.number(),
});
const entrySchema = z.discriminatedUnion("type", [
  entryBaseSchema.extend({ type: z.literal("user"), content: jsonValueSchema }).strict(),
  entryBaseSchema.extend({ type: z.literal("assistant"), content: jsonValueSchema }).strict(),
  entryBaseSchema
    .extend({
      type: z.literal("tool"),
      name: z.string(),
      arguments: jsonValueSchema,
      result: jsonValueSchema,
      outcome: z.enum(["succeeded", "failed", "blocked", "cancelled"]),
    })
    .strict(),
]);
const searchResultSchema = z
  .object({
    sessions: z.array(descriptorSchema),
    nextCursor: z.string().optional(),
  })
  .strict();
const readResultSchema = z
  .object({
    session: descriptorSchema,
    entries: z.array(entrySchema),
    nextCursor: z.string().optional(),
  })
  .strict();

export class RemoteHistoryClient implements HistoryQuery {
  constructor(
    private readonly target: HistoryRemoteTarget,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async applyOperations(
    operations: HistoryReplicationOperation[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (operations.length === 0) return;
    await this.request("/v1/operations", { operations }, signal);
  }

  async search(input: HistorySearchInput, signal?: AbortSignal): Promise<HistorySearchResult> {
    const value = await this.request("/v1/search", input, signal);
    const parsed = searchResultSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error(
        `History service returned invalid search results: ${formatZodError(parsed.error)}`,
      );
    }
    return parsed.data as HistorySearchResult;
  }

  async read(input: HistoryReadInput, signal?: AbortSignal): Promise<HistoryReadResult> {
    const value = await this.request("/v1/read", input, signal);
    const parsed = readResultSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error(
        `History service returned invalid transcript data: ${formatZodError(parsed.error)}`,
      );
    }
    return parsed.data as HistoryReadResult;
  }

  private async request(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetchImpl(`${this.target.endpoint}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.target.apiKey}`,
        "content-type": "application/json",
        "user-agent": "tau-history",
      },
      body: JSON.stringify(body),
      signal,
    });
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && Number(contentLength) > MAX_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => {});
      throw new Error("History service response exceeded the 16 MiB limit");
    }
    const text = await readBoundedResponse(response);
    let value: unknown;
    try {
      value = text ? JSON.parse(text) : undefined;
    } catch {
      throw new Error("History service returned a non-JSON response");
    }
    if (!response.ok) {
      const remoteError =
        typeof value === "object" &&
        value !== null &&
        "error" in value &&
        typeof value.error === "object" &&
        value.error !== null
          ? value.error
          : undefined;
      const code =
        remoteError && "code" in remoteError && typeof remoteError.code === "string"
          ? remoteError.code
          : undefined;
      const message =
        remoteError && "message" in remoteError && typeof remoteError.message === "string"
          ? remoteError.message
          : `History service request failed with HTTP ${response.status}`;
      throw new RemoteHistoryError(response.status, code, message);
    }
    return value;
  }
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteCount += value.byteLength;
    if (byteCount > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("History service response exceeded the 16 MiB limit");
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}
