type Env = {
  DB: D1Database;
  AI: Ai;
  API_KEY: string;
};

type D1Database = {
  exec(query: string): Promise<unknown>;
  prepare(query: string): D1PreparedStatement;
};

type D1PreparedStatement = {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean }>;
};

type Ai = {
  run(model: string, input: unknown): Promise<unknown>;
};

type ExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

type HistoryEntry = {
  id: string;
  sourceIds: string[];
  type: "user" | "assistant" | "tool";
  timestamp: number;
  [key: string]: unknown;
};

type Operation =
  | {
      id: string;
      sessionId: string;
      type: "create";
      session: {
        sessionId: string;
        attributes: Record<string, string>;
        createdAt: number;
      };
    }
  | { id: string; sessionId: string; type: "append"; entries: HistoryEntry[] }
  | { id: string; sessionId: string; type: "truncate"; afterEntryId: string | null };

const DIGEST_MODEL = "@cf/zai-org/glm-4.7-flash";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_OPERATIONS = 1;
const MAX_ENTRIES_PER_OPERATION = 10;
const MAX_SEARCH_LIMIT = 100;
const MAX_READ_LIMIT = 100;
const SHORT_SESSION_ENTRIES = 12;
const ESTABLISHED_REFRESH_CHARS = 4_000;
const DIGEST_CHUNK_CHARS = 300_000;

let initialization: Promise<void> | undefined;

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    if (!authorize(request, env)) return error("unauthorized", "Invalid API key", 401);
    if (request.method !== "POST") return error("method_not_allowed", "Use POST", 405);
    await initialize(env.DB);

    try {
      if (new URL(request.url).pathname === "/v1/operations") {
        const body = await readJson(request);
        const operations = parseOperations(body);
        const sessions = new Set<string>();
        const forcedDigestSessions = new Set<string>();
        for (const operation of operations) {
          const applied = await applyOperation(env.DB, operation);
          if (!applied) continue;
          sessions.add(operation.sessionId);
          if (operation.type === "truncate") forcedDigestSessions.add(operation.sessionId);
        }
        for (const sessionId of sessions) {
          context.waitUntil(
            refreshDigestIfNeeded(env, sessionId, forcedDigestSessions.has(sessionId)).catch(
              () => undefined,
            ),
          );
        }
        return json({ applied: operations.length });
      }

      if (new URL(request.url).pathname === "/v1/search") {
        return json(await search(env.DB, await readJson(request)));
      }

      if (new URL(request.url).pathname === "/v1/read") {
        return json(await read(env.DB, await readJson(request)));
      }

      return error("not_found", "Not found", 404);
    } catch (caught) {
      return error(
        "invalid_request",
        caught instanceof Error ? caught.message : String(caught),
        400,
      );
    }
  },

  async scheduled(_controller: unknown, env: Env, context: ExecutionContext): Promise<void> {
    await initialize(env.DB);
    const stale = await env.DB.prepare(
      `SELECT s.session_id
       FROM sessions s
       JOIN entries latest ON latest.session_id = s.session_id
         AND latest.position = (SELECT MAX(position) FROM entries WHERE session_id = s.session_id)
       WHERE (s.digest_through_entry_id IS NULL OR s.digest_through_entry_id != latest.entry_id)
         AND s.updated_at <= ?
       ORDER BY s.updated_at
       LIMIT 5`,
    )
      .bind(Date.now() - 30 * 60 * 1_000)
      .all<{ session_id: string }>();
    for (const session of stale.results) {
      context.waitUntil(
        refreshDigestIfNeeded(env, session.session_id, true).catch(() => undefined),
      );
    }
  },
};

function authorize(request: Request, env: Env): boolean {
  const expected = env.API_KEY?.trim();
  if (!expected) return false;
  return request.headers.get("authorization") === `Bearer ${expected}`;
}

async function initialize(database: D1Database): Promise<void> {
  if (!initialization) {
    initialization = database
      .exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          session_id TEXT PRIMARY KEY,
          attributes_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          digest_title TEXT,
          digest_summary TEXT,
          digest_through_entry_id TEXT
        );
        CREATE TABLE IF NOT EXISTS attributes (
          session_id TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          PRIMARY KEY (session_id, key)
        );
        CREATE INDEX IF NOT EXISTS attributes_lookup ON attributes(key, value, session_id);
        CREATE TABLE IF NOT EXISTS entries (
          session_id TEXT NOT NULL,
          position INTEGER NOT NULL,
          entry_id TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          search_text TEXT NOT NULL,
          PRIMARY KEY (session_id, entry_id),
          UNIQUE (session_id, position)
        );
        CREATE INDEX IF NOT EXISTS entries_order ON entries(session_id, position);
        CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
          session_id UNINDEXED,
          entry_id UNINDEXED,
          position UNINDEXED,
          text
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
          session_id UNINDEXED,
          title,
          summary
        );
        CREATE TABLE IF NOT EXISTS operations (
          operation_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          applied_at INTEGER NOT NULL
        );
      `)
      .then(() => undefined)
      .catch((caught) => {
        initialization = undefined;
        throw caught;
      });
  }
  await initialization;
}

async function applyOperation(database: D1Database, operation: Operation): Promise<boolean> {
  const existing = await database
    .prepare("SELECT 1 AS found FROM operations WHERE operation_id = ?")
    .bind(operation.id)
    .first();
  if (existing) return false;

  if (operation.type === "create") {
    const attributesJson = stableJson(operation.session.attributes);
    const session = await database
      .prepare("SELECT attributes_json, created_at FROM sessions WHERE session_id = ?")
      .bind(operation.sessionId)
      .first<{ attributes_json: string; created_at: number }>();
    if (session) {
      if (
        session.attributes_json !== attributesJson ||
        session.created_at !== operation.session.createdAt
      ) {
        throw new Error(`session '${operation.sessionId}' has conflicting immutable data`);
      }
    } else {
      await database
        .prepare(
          "INSERT INTO sessions (session_id, attributes_json, created_at, updated_at) VALUES (?, ?, ?, ?)",
        )
        .bind(
          operation.sessionId,
          attributesJson,
          operation.session.createdAt,
          operation.session.createdAt,
        )
        .run();
    }
    for (const [key, value] of Object.entries(operation.session.attributes)) {
      await database
        .prepare("INSERT OR IGNORE INTO attributes (session_id, key, value) VALUES (?, ?, ?)")
        .bind(operation.sessionId, key, value)
        .run();
    }
  } else if (operation.type === "append") {
    await requireSession(database, operation.sessionId);
    const current = await database
      .prepare("SELECT COALESCE(MAX(position), 0) AS position FROM entries WHERE session_id = ?")
      .bind(operation.sessionId)
      .first<{ position: number }>();
    let position = Number(current?.position ?? 0);
    let updatedAt = 0;
    for (const entry of operation.entries) {
      const duplicate = await database
        .prepare("SELECT 1 AS found FROM entries WHERE session_id = ? AND entry_id = ?")
        .bind(operation.sessionId, entry.id)
        .first();
      if (duplicate) continue;
      position += 1;
      updatedAt = Math.max(updatedAt, entry.timestamp);
      const searchText = entrySearchText(entry);
      await database
        .prepare(
          "INSERT INTO entries (session_id, position, entry_id, timestamp, payload_json, search_text) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(
          operation.sessionId,
          position,
          entry.id,
          entry.timestamp,
          JSON.stringify(entry),
          searchText,
        )
        .run();
      await database
        .prepare(
          "INSERT INTO entries_fts (session_id, entry_id, position, text) VALUES (?, ?, ?, ?)",
        )
        .bind(operation.sessionId, entry.id, position, searchText)
        .run();
    }
    if (updatedAt > 0) {
      await database
        .prepare("UPDATE sessions SET updated_at = MAX(updated_at, ?) WHERE session_id = ?")
        .bind(updatedAt, operation.sessionId)
        .run();
    }
  } else {
    await requireSession(database, operation.sessionId);
    if (operation.afterEntryId === null) {
      await database
        .prepare("DELETE FROM entries_fts WHERE session_id = ?")
        .bind(operation.sessionId)
        .run();
      await database
        .prepare("DELETE FROM entries WHERE session_id = ?")
        .bind(operation.sessionId)
        .run();
    } else {
      const retained = await database
        .prepare("SELECT position FROM entries WHERE session_id = ? AND entry_id = ?")
        .bind(operation.sessionId, operation.afterEntryId)
        .first<{ position: number }>();
      if (!retained) throw new Error(`truncate entry '${operation.afterEntryId}' was not found`);
      await database
        .prepare("DELETE FROM entries_fts WHERE session_id = ? AND CAST(position AS INTEGER) > ?")
        .bind(operation.sessionId, retained.position)
        .run();
      await database
        .prepare("DELETE FROM entries WHERE session_id = ? AND position > ?")
        .bind(operation.sessionId, retained.position)
        .run();
    }
    await database
      .prepare("DELETE FROM sessions_fts WHERE session_id = ?")
      .bind(operation.sessionId)
      .run();
    await database
      .prepare(
        "UPDATE sessions SET updated_at = ?, digest_title = NULL, digest_summary = NULL, digest_through_entry_id = NULL WHERE session_id = ?",
      )
      .bind(Date.now(), operation.sessionId)
      .run();
  }

  await database
    .prepare("INSERT INTO operations (operation_id, session_id, applied_at) VALUES (?, ?, ?)")
    .bind(operation.id, operation.sessionId, Date.now())
    .run();
  return true;
}

async function search(database: D1Database, raw: unknown): Promise<unknown> {
  const input = asRecord(raw, "search input");
  const query = optionalString(input.query, "query", 1_000)?.trim();
  const attributes = parseAttributes(input.attributes, true);
  const limit = boundedInteger(input.limit ?? 10, "limit", 1, MAX_SEARCH_LIMIT);
  const offset = decodeCursor(optionalString(input.cursor, "cursor", 2_048), "offset");
  const attributeValues: unknown[] = [];
  const attributeFilters = Object.entries(attributes).map(([key, value]) => {
    attributeValues.push(key, value);
    return "EXISTS (SELECT 1 FROM attributes a WHERE a.session_id = s.session_id AND a.key = ? AND a.value = ?)";
  });
  const attributeClause =
    attributeFilters.length > 0 ? `AND ${attributeFilters.join(" AND ")}` : "";

  if (!query) {
    const rows = await database
      .prepare(
        `SELECT s.* FROM sessions s
         WHERE 1 = 1 ${attributeClause}
         ORDER BY s.updated_at DESC, s.session_id ASC LIMIT ? OFFSET ?`,
      )
      .bind(...attributeValues, limit + 1, offset)
      .all<Record<string, unknown>>();
    return {
      sessions: rows.results.slice(0, limit).map((row) => descriptor(row)),
      ...(rows.results.length > limit
        ? { nextCursor: encodeCursor({ offset: offset + limit }) }
        : {}),
    };
  }

  const ftsQuery = buildFtsQuery(query);
  const candidateLimit = Math.min(1_000, offset + limit + 200);
  const digestRows = await database
    .prepare(
      `SELECT s.*, bm25(sessions_fts, 0, 10, 5) AS score
       FROM sessions_fts
       JOIN sessions s ON s.session_id = sessions_fts.session_id
       WHERE sessions_fts MATCH ? ${attributeClause}
       ORDER BY score, s.updated_at DESC, s.session_id ASC LIMIT ?`,
    )
    .bind(ftsQuery, ...attributeValues, candidateLimit)
    .all<Record<string, unknown>>();
  const transcriptRows = await database
    .prepare(
      `SELECT s.*, entries_fts.text AS match_text, bm25(entries_fts) AS score
       FROM entries_fts
       JOIN sessions s ON s.session_id = entries_fts.session_id
       WHERE entries_fts MATCH ? ${attributeClause}
       ORDER BY score, s.updated_at DESC, s.session_id ASC LIMIT ?`,
    )
    .bind(ftsQuery, ...attributeValues, candidateLimit)
    .all<Record<string, unknown>>();

  const matches = new Map<string, Record<string, unknown>>();
  for (const row of digestRows.results) {
    const session = descriptor(row);
    matches.set(String(session.sessionId), session);
  }
  for (const row of transcriptRows.results) {
    const sessionId = String(row.session_id);
    const session = matches.get(sessionId) ?? descriptor(row);
    const snippets = session.snippets as string[];
    if (snippets.length < 3 && typeof row.match_text === "string") {
      snippets.push(boundedSnippet(row.match_text, query));
    }
    matches.set(sessionId, session);
  }

  const ordered = [...matches.values()];
  const selected = ordered.slice(offset, offset + limit);
  return {
    sessions: selected,
    ...(ordered.length > offset + limit
      ? { nextCursor: encodeCursor({ offset: offset + limit }) }
      : {}),
  };
}

async function read(database: D1Database, raw: unknown): Promise<unknown> {
  const input = asRecord(raw, "read input");
  const sessionId = requiredString(input.sessionId, "sessionId", 256);
  const limit = boundedInteger(input.limit ?? 50, "limit", 1, MAX_READ_LIMIT);
  const position = decodeCursor(optionalString(input.cursor, "cursor", 2_048), "position");
  const session = await database
    .prepare("SELECT * FROM sessions WHERE session_id = ?")
    .bind(sessionId)
    .first<Record<string, unknown>>();
  if (!session) throw new Error(`history session '${sessionId}' was not found`);
  const rows = await database
    .prepare(
      "SELECT position, payload_json FROM entries WHERE session_id = ? AND position > ? ORDER BY position LIMIT ?",
    )
    .bind(sessionId, position, limit + 1)
    .all<{ position: number; payload_json: string }>();
  const selected = rows.results.slice(0, limit);
  const last = selected.at(-1);
  return {
    session: descriptor(session),
    entries: selected.map((row) => JSON.parse(row.payload_json)),
    ...(rows.results.length > limit && last
      ? { nextCursor: encodeCursor({ position: last.position }) }
      : {}),
  };
}

function descriptor(row: Record<string, unknown>): Record<string, unknown> {
  const title = typeof row.digest_title === "string" ? row.digest_title : undefined;
  const summary = typeof row.digest_summary === "string" ? row.digest_summary : undefined;
  const through =
    typeof row.digest_through_entry_id === "string" ? row.digest_through_entry_id : undefined;
  return {
    sessionId: String(row.session_id),
    attributes: JSON.parse(String(row.attributes_json)),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(title && summary && through
      ? { digest: { title, summary, updatedThroughEntryId: through } }
      : {}),
    snippets: [],
  };
}

async function refreshDigestIfNeeded(env: Env, sessionId: string, force: boolean): Promise<void> {
  const session = await env.DB.prepare(
    "SELECT digest_title, digest_summary, digest_through_entry_id FROM sessions WHERE session_id = ?",
  )
    .bind(sessionId)
    .first<Record<string, unknown>>();
  if (!session) return;
  const latest = await env.DB.prepare(
    "SELECT position, entry_id FROM entries WHERE session_id = ? ORDER BY position DESC LIMIT 1",
  )
    .bind(sessionId)
    .first<{ position: number; entry_id: string }>();
  if (!latest) return;
  if (session.digest_through_entry_id === latest.entry_id && !force) return;

  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM entries WHERE session_id = ?")
    .bind(sessionId)
    .first<{ count: number }>();
  const digestThrough =
    typeof session.digest_through_entry_id === "string"
      ? await env.DB.prepare("SELECT position FROM entries WHERE session_id = ? AND entry_id = ?")
          .bind(sessionId, session.digest_through_entry_id)
          .first<{ position: number }>()
      : null;
  const newContent = await env.DB.prepare(
    "SELECT COALESCE(SUM(LENGTH(payload_json)), 0) AS chars FROM entries WHERE session_id = ? AND position > ?",
  )
    .bind(sessionId, Number(digestThrough?.position ?? 0))
    .first<{ chars: number }>();
  const shouldRefresh =
    force ||
    !session.digest_through_entry_id ||
    Number(count?.count ?? 0) <= SHORT_SESSION_ENTRIES ||
    Number(newContent?.chars ?? 0) >= ESTABLISHED_REFRESH_CHARS;
  if (!shouldRefresh) return;

  const rows = await env.DB.prepare(
    "SELECT payload_json FROM entries WHERE session_id = ? ORDER BY position",
  )
    .bind(sessionId)
    .all<{ payload_json: string }>();
  const source = rows.results.map((row) => row.payload_json).join("\n");
  const previous =
    typeof session.digest_title === "string" && typeof session.digest_summary === "string"
      ? { title: session.digest_title, summary: session.digest_summary }
      : undefined;
  const digest = await generateDigest(env.AI, source, previous);
  await env.DB.prepare("DELETE FROM sessions_fts WHERE session_id = ?").bind(sessionId).run();
  await env.DB.prepare("INSERT INTO sessions_fts (session_id, title, summary) VALUES (?, ?, ?)")
    .bind(sessionId, digest.title, digest.summary)
    .run();
  await env.DB.prepare(
    "UPDATE sessions SET digest_title = ?, digest_summary = ?, digest_through_entry_id = ? WHERE session_id = ?",
  )
    .bind(digest.title, digest.summary, latest.entry_id, sessionId)
    .run();
}

async function generateDigest(
  ai: Ai,
  transcript: string,
  previous?: { title: string; summary: string },
): Promise<{ title: string; summary: string }> {
  const chunks = chunkText(transcript, DIGEST_CHUNK_CHARS);
  const summaries: string[] = [];
  if (chunks.length > 1) {
    for (let index = 0; index < chunks.length; index += 1) {
      summaries.push(
        await runAi(
          ai,
          `Summarize transcript chunk ${index + 1}/${chunks.length} as reusable context. Preserve intent, decisions, constraints, work, findings, outcomes, and unresolved work.\n\n${chunks[index]}`,
        ),
      );
    }
  }
  const source = chunks.length <= 1 ? transcript : summaries.join("\n\n");
  const stability = previous
    ? `Previous digest (use only as a phrasing stability hint, not as factual source):\n${JSON.stringify(previous)}\n\n`
    : "";
  const response = await runAi(
    ai,
    `${stability}Generate a complete replacement digest from the current active Tau transcript below. The title must be specific and concise. The summary must optimize for reusable context: original intent, important decisions and constraints, meaningful work, key findings or outcomes, and unresolved questions or remaining work. Omit tool-by-tool narration and incidental conversation. Return only JSON with string fields "title" and "summary".\n\n${source}`,
  );
  return parseDigest(response);
}

async function runAi(ai: Ai, prompt: string): Promise<string> {
  const result = await ai.run(DIGEST_MODEL, {
    messages: [{ role: "user", content: prompt }],
    max_completion_tokens: 1_024,
    reasoning_effort: "low",
  });
  if (typeof result !== "object" || result === null) {
    throw new Error("Workers AI returned an invalid digest response");
  }
  if ("response" in result && typeof result.response === "string") {
    return result.response;
  }
  if ("choices" in result && Array.isArray(result.choices)) {
    const first = result.choices[0];
    if (
      typeof first === "object" &&
      first !== null &&
      "message" in first &&
      typeof first.message === "object" &&
      first.message !== null &&
      "content" in first.message &&
      typeof first.message.content === "string"
    ) {
      return first.message.content;
    }
  }
  throw new Error("Workers AI returned an invalid digest response");
}

function parseDigest(value: string): { title: string; summary: string } {
  const match = value.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("digest response did not contain JSON");
  const parsed = JSON.parse(match[0]) as Record<string, unknown>;
  if (typeof parsed.title !== "string" || typeof parsed.summary !== "string") {
    throw new Error("digest response was missing title or summary");
  }
  const title = parsed.title.trim();
  const summary = parsed.summary.trim();
  if (!title || !summary) throw new Error("digest title and summary must not be empty");
  return { title: title.slice(0, 200), summary: summary.slice(0, 4_000) };
}

function parseOperations(raw: unknown): Operation[] {
  const body = asRecord(raw, "operations request");
  if (!Array.isArray(body.operations) || body.operations.length > MAX_OPERATIONS) {
    throw new Error(`operations must be an array of at most ${MAX_OPERATIONS} items`);
  }
  return body.operations.map((value): Operation => {
    const operation = asRecord(value, "operation");
    const id = requiredString(operation.id, "operation.id", 256);
    const sessionId = requiredString(operation.sessionId, "operation.sessionId", 256);
    if (operation.type === "create") {
      const session = asRecord(operation.session, "operation.session");
      if (requiredString(session.sessionId, "session.sessionId", 256) !== sessionId) {
        throw new Error("operation session IDs do not match");
      }
      return {
        id,
        sessionId,
        type: "create",
        session: {
          sessionId,
          attributes: parseAttributes(session.attributes, false),
          createdAt: finiteNumber(session.createdAt, "session.createdAt"),
        },
      };
    }
    if (operation.type === "append") {
      if (
        !Array.isArray(operation.entries) ||
        operation.entries.length > MAX_ENTRIES_PER_OPERATION
      ) {
        throw new Error(`append entries must contain at most ${MAX_ENTRIES_PER_OPERATION} items`);
      }
      return {
        id,
        sessionId,
        type: "append",
        entries: operation.entries.map(parseEntry),
      };
    }
    if (operation.type === "truncate") {
      return {
        id,
        sessionId,
        type: "truncate",
        afterEntryId:
          operation.afterEntryId === null
            ? null
            : requiredString(operation.afterEntryId, "operation.afterEntryId", 512),
      };
    }
    throw new Error("unsupported history operation type");
  });
}

function parseEntry(raw: unknown): HistoryEntry {
  const entry = asRecord(raw, "entry");
  const type = entry.type;
  if (type !== "user" && type !== "assistant" && type !== "tool") {
    throw new Error("entry.type is invalid");
  }
  if (!Array.isArray(entry.sourceIds) || entry.sourceIds.length === 0) {
    throw new Error("entry.sourceIds must be a non-empty array");
  }
  return {
    ...entry,
    id: requiredString(entry.id, "entry.id", 512),
    sourceIds: entry.sourceIds.map((value) => requiredString(value, "entry.sourceId", 512)),
    type,
    timestamp: finiteNumber(entry.timestamp, "entry.timestamp"),
  };
}

function parseAttributes(raw: unknown, optional: boolean): Record<string, string> {
  if (raw === undefined && optional) return {};
  const attributes = asRecord(raw, "attributes");
  const entries = Object.entries(attributes);
  if (entries.length > 32) throw new Error("at most 32 attributes are allowed");
  return Object.fromEntries(
    entries.map(([key, value]) => {
      if (
        key.length === 0 ||
        key.length > 64 ||
        typeof value !== "string" ||
        value.length > 1_024
      ) {
        throw new Error("attributes must contain bounded string pairs");
      }
      return [key, value];
    }),
  );
}

async function requireSession(database: D1Database, sessionId: string): Promise<void> {
  const session = await database
    .prepare("SELECT 1 AS found FROM sessions WHERE session_id = ?")
    .bind(sessionId)
    .first();
  if (!session) throw new Error(`history session '${sessionId}' was not created`);
}

async function readJson(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) throw new Error("request body is too large");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new Error("request body is too large");
  }
  return JSON.parse(text);
}

function entrySearchText(entry: HistoryEntry): string {
  return recursiveText(entry).slice(0, 1_000_000);
}

function recursiveText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(recursiveText).filter(Boolean).join("\n");
  if (typeof value !== "object" || value === null) return "";
  return Object.values(value).map(recursiveText).filter(Boolean).join("\n");
}

function chunkText(value: string, size: number): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; offset += size) {
    chunks.push(value.slice(offset, offset + size));
  }
  return chunks;
}

function stableJson(value: Record<string, string>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))),
  );
}

function boundedSnippet(text: string, query: string): string {
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, index - 120);
  const end = Math.min(text.length, start + 360);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function buildFtsQuery(query: string): string {
  const terms = query.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  if (terms.length === 0) return `"${query.replaceAll('"', '""')}"`;
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}

function encodeCursor(value: Record<string, number>): string {
  return btoa(JSON.stringify(value));
}

function decodeCursor(cursor: string | undefined, field: "offset" | "position"): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(atob(cursor)) as Record<string, unknown>;
    const value = parsed[field];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  } catch {}
  throw new Error("invalid cursor");
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error(`${name} must be a bounded non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, name: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, name, maxLength);
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
  return value;
}

function boundedInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function error(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status);
}
