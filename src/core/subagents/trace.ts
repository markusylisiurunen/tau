import { randomUUID } from "node:crypto";
import { AgentRequestError } from "./errors.js";
import type { ContentBlock, ObservableEvent } from "./events.js";

export type TraceContent =
  | { kind: "inline"; blocks: ContentBlock[] }
  | { kind: "reference"; ref: string; bytes: number };
export type TraceEvent =
  | { kind: "input"; mode: "initial" | "queue" | "steer"; content: ContentBlock[] }
  | ObservableEvent
  | {
      kind: "status";
      status: "working" | "stopping" | "idle";
      reason?: "completed" | "failed" | "interrupted";
    };
export type TraceKind = TraceEvent["kind"];
type StoredEvent<T> = T extends { content: ContentBlock[] }
  ? Omit<T, "content"> & { content: TraceContent }
  : T extends { arguments: ContentBlock[] }
    ? Omit<T, "arguments"> & { arguments: TraceContent }
    : T;
export type TraceEntry = StoredEvent<TraceEvent> & { seq: number; timestamp: number };

const INLINE_BYTES = 4096;
const PAGE_CHARS = 16384;
const RETENTION_BYTES = 64 * 1024 * 1024;

export class AgentTrace {
  private entries: { entry: TraceEntry; bytes: number; ref?: string }[] = [];
  private contents = new Map<string, ContentBlock[]>();
  private bytes = 0;
  private sequence = 0;
  private evicted = false;
  private readonly key = randomUUID();

  append(event: TraceEvent, timestamp = Date.now()): number {
    const seq = ++this.sequence;
    let ref: string | undefined;
    let retainedBytes = 0;
    const store = (blocks: ContentBlock[]): TraceContent => {
      blocks = boundedTraceBlocks(blocks);
      const bytes = Buffer.byteLength(JSON.stringify(blocks));
      if (bytes <= INLINE_BYTES && !blocks.some((block) => block.type === "image")) {
        return { kind: "inline", blocks: structuredClone(blocks) };
      }
      ref = `${this.key}:${seq}`;
      this.contents.set(ref, structuredClone(blocks));
      retainedBytes = bytes;
      return { kind: "reference", ref, bytes };
    };
    const entry = {
      ...event,
      seq,
      timestamp,
      ...("content" in event ? { content: store(event.content) } : {}),
      ...("arguments" in event ? { arguments: store(event.arguments) } : {}),
    } as TraceEntry;
    const bytes = Buffer.byteLength(JSON.stringify(entry)) + retainedBytes;
    this.entries.push({ entry, bytes, ref });
    this.bytes += bytes;
    while (this.bytes > RETENTION_BYTES || this.entries.length > 4096) {
      const old = this.entries.shift()!;
      this.bytes -= old.bytes;
      if (old.ref) this.contents.delete(old.ref);
      this.evicted = true;
    }
    return seq;
  }

  trace(options: { kinds?: TraceKind[]; toolName?: string; limit?: number; cursor?: string }) {
    const query = JSON.stringify([options.kinds ?? null, options.toolName ?? null]);
    let before = this.sequence + 1;
    if (options.cursor) {
      const cursor = this.decode(options.cursor);
      if (cursor.query !== query || !Number.isInteger(cursor.before))
        throw new AgentRequestError("invalid_cursor", "Invalid trace cursor");
      before = cursor.before as number;
    }
    const matching = this.entries.filter(
      ({ entry }) =>
        entry.seq < before &&
        (!options.kinds || options.kinds.includes(entry.kind)) &&
        (!options.toolName || ("toolName" in entry && entry.toolName === options.toolName)),
    );
    const selected = matching.slice(-(options.limit ?? 20));
    return {
      entries: structuredClone(selected.map(({ entry }) => entry)),
      nextCursor:
        matching.length > selected.length
          ? this.encode({ query, before: selected[0]!.entry.seq })
          : null,
      historyEvicted: this.evicted,
    };
  }

  readContent(options: { ref: string; cursor?: string }) {
    const blocks = this.contents.get(options.ref);
    if (!blocks)
      throw new AgentRequestError("expired_content", "Unknown or expired content reference");
    let index = 0;
    let offset = 0;
    if (options.cursor) {
      const cursor = this.decode(options.cursor);
      if (
        cursor.ref !== options.ref ||
        !Number.isInteger(cursor.index) ||
        !Number.isInteger(cursor.offset)
      )
        throw new AgentRequestError("invalid_cursor", "Invalid content cursor");
      index = cursor.index as number;
      offset = cursor.offset as number;
    }
    const block = blocks[index];
    if (!block || offset < 0 || (block.type === "text" ? offset > block.text.length : offset !== 0))
      throw new AgentRequestError("invalid_cursor", "Invalid content cursor");
    let result: ContentBlock;
    if (block.type === "text") {
      let end = Math.min(offset + PAGE_CHARS, block.text.length);
      if (end < block.text.length && /[\uD800-\uDBFF]/.test(block.text[end - 1]!)) end--;
      result = { type: "text", text: block.text.slice(offset, end) };
      offset = end;
      if (end === block.text.length) {
        index++;
        offset = 0;
      }
    } else {
      result = structuredClone(block);
      index++;
      offset = 0;
    }
    return {
      blocks: [result],
      nextCursor: index < blocks.length ? this.encode({ ref: options.ref, index, offset }) : null,
    };
  }

  readText(seq: number, maxChars = 30000) {
    const entry = this.entries.find((item) => item.entry.seq === seq)?.entry;
    if (!entry) throw new AgentRequestError("expired_content", "Unknown or expired trace entry");
    if (entry.kind !== "assistant" && entry.kind !== "tool_result")
      throw new AgentRequestError(
        "content_type",
        "Entry is not an assistant message or tool result",
      );
    const blocks =
      entry.content.kind === "inline" ? entry.content.blocks : this.contents.get(entry.content.ref);
    if (!blocks) throw new AgentRequestError("expired_content", "Expired content reference");
    if (blocks.some((block) => block.type !== "text" && block.type !== "unavailable"))
      throw new AgentRequestError("content_type", "Mixed content requires readContent");
    const text = blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    let end = Math.min(maxChars, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    return {
      text: text.slice(0, end),
      complete: end === text.length && !blocks.some((block) => block.type === "unavailable"),
    };
  }

  private encode(value: Record<string, unknown>): string {
    return Buffer.from(JSON.stringify({ ...value, key: this.key })).toString("base64url");
  }

  private decode(value: string): Record<string, unknown> {
    let cursor: unknown;
    try {
      cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    } catch {
      throw new AgentRequestError("invalid_cursor", "Invalid cursor");
    }
    if (!cursor || typeof cursor !== "object" || !("key" in cursor) || cursor.key !== this.key)
      throw new AgentRequestError("invalid_cursor", "Invalid cursor");
    return cursor as Record<string, unknown>;
  }
}

export function boundedTraceBlocks(blocks: ContentBlock[]): ContentBlock[] {
  return Buffer.byteLength(JSON.stringify(blocks)) <= 6 * 1024 * 1024
    ? blocks
    : [{ type: "unavailable", reason: "Content exceeds the 6 MiB retention limit." }];
}
