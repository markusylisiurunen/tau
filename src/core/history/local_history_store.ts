import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  HistoryEntry,
  HistoryReadInput,
  HistoryReadResult,
  HistoryRemoteTarget,
  HistoryReplicationOperation,
  HistorySearchInput,
  HistorySearchResult,
  HistorySessionDescriptor,
  HistorySessionRecord,
} from "./types.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_SEARCH_SNIPPETS = 3;
const MAX_REPLICATION_ENTRIES = 100;

type SqlValue = string | number | null;
type SqlRow = Record<string, SqlValue>;

type PendingReplicationOperation = {
  rowId: number;
  operation: HistoryReplicationOperation;
};

export function getDefaultHistoryDatabasePath(homeDir?: string): string {
  return join(homeDir ?? homedir(), ".config", "tau", "history.sqlite");
}

export class LocalHistoryStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
      chmodSync(dirname(path), PRIVATE_DIRECTORY_MODE);
    }
    this.database = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, PRIVATE_FILE_MODE);
    this.initialize();
  }

  close(): void {
    this.database.close();
  }

  createSession(session: HistorySessionRecord, remote?: HistoryRemoteTarget): void {
    this.transaction(() => {
      const existing = this.database
        .prepare("SELECT attributes_json, created_at FROM history_sessions WHERE session_id = ?")
        .get(session.sessionId) as SqlRow | undefined;
      const attributesJson = stableJson(session.attributes);
      if (existing) {
        if (
          existing.attributes_json !== attributesJson ||
          existing.created_at !== session.createdAt
        ) {
          throw new Error(`history session '${session.sessionId}' has conflicting immutable data`);
        }
      } else {
        this.database
          .prepare(
            "INSERT INTO history_sessions (session_id, attributes_json, created_at, updated_at) VALUES (?, ?, ?, ?)",
          )
          .run(session.sessionId, attributesJson, session.createdAt, session.createdAt);
        const insertAttribute = this.database.prepare(
          "INSERT INTO history_attributes (session_id, key, value) VALUES (?, ?, ?)",
        );
        for (const [key, value] of Object.entries(session.attributes)) {
          insertAttribute.run(session.sessionId, key, value);
        }
      }

      if (remote) {
        const targetInsert = this.database
          .prepare(
            "INSERT OR IGNORE INTO history_replication_targets (session_id, endpoint) VALUES (?, ?)",
          )
          .run(session.sessionId, remote.endpoint);
        if (Number(targetInsert.changes) > 0) {
          this.enqueue(remote.endpoint, {
            id: randomUUID(),
            sessionId: session.sessionId,
            type: "create",
            session,
          });
        }
      }
    });
  }

  append(sessionId: string, entries: HistoryEntry[], remote?: HistoryRemoteTarget): HistoryEntry[] {
    if (entries.length === 0) return [];
    return this.transaction(() => {
      this.requireSession(sessionId);
      const existingIds = new Set(
        (
          this.database
            .prepare(
              `SELECT entry_id FROM history_entries WHERE session_id = ? AND entry_id IN (${entries.map(() => "?").join(", ")})`,
            )
            .all(sessionId, ...entries.map((entry) => entry.id)) as SqlRow[]
        ).map((row) => String(row.entry_id)),
      );
      const inserted = entries.filter((entry) => !existingIds.has(entry.id));
      if (inserted.length === 0) return [];

      const lastPosition = this.database
        .prepare(
          "SELECT COALESCE(MAX(position), 0) AS position FROM history_entries WHERE session_id = ?",
        )
        .get(sessionId) as SqlRow;
      let position = Number(lastPosition.position);
      const insertEntry = this.database.prepare(
        "INSERT INTO history_entries (session_id, position, entry_id, type, timestamp, payload_json, search_text) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      const insertSearch = this.database.prepare(
        "INSERT INTO history_entries_fts (rowid, session_id, text) VALUES (?, ?, ?)",
      );
      const insertSource = this.database.prepare(
        "INSERT INTO history_entry_sources (session_id, entry_id, source_id) VALUES (?, ?, ?)",
      );
      for (const entry of inserted) {
        position += 1;
        const searchText = historyEntrySearchText(entry);
        const result = insertEntry.run(
          sessionId,
          position,
          entry.id,
          entry.type,
          entry.timestamp,
          JSON.stringify(entry),
          searchText,
        );
        insertSearch.run(Number(result.lastInsertRowid), sessionId, searchText);
        for (const sourceId of new Set(entry.sourceIds)) {
          insertSource.run(sessionId, entry.id, sourceId);
        }
      }
      const updatedAt = Math.max(...inserted.map((entry) => entry.timestamp), Date.now());
      this.database
        .prepare("UPDATE history_sessions SET updated_at = MAX(updated_at, ?) WHERE session_id = ?")
        .run(updatedAt, sessionId);
      if (remote) {
        for (let offset = 0; offset < inserted.length; offset += MAX_REPLICATION_ENTRIES) {
          this.enqueue(remote.endpoint, {
            id: randomUUID(),
            sessionId,
            type: "append",
            entries: inserted.slice(offset, offset + MAX_REPLICATION_ENTRIES),
          });
        }
      }
      return inserted;
    });
  }

  truncateFromSources(
    sessionId: string,
    sourceIds: string[],
    remote?: HistoryRemoteTarget,
  ): string | null | undefined {
    if (sourceIds.length === 0) return undefined;
    return this.transaction(() => {
      const firstRemoved = this.database
        .prepare(
          `SELECT MIN(e.position) AS position
           FROM history_entries e
           JOIN history_entry_sources s
             ON s.session_id = e.session_id AND s.entry_id = e.entry_id
           WHERE e.session_id = ? AND s.source_id IN (${sourceIds.map(() => "?").join(", ")})`,
        )
        .get(sessionId, ...sourceIds) as SqlRow;
      if (firstRemoved.position === null) return undefined;
      const position = Number(firstRemoved.position);
      const removedRows = this.database
        .prepare(
          "SELECT rowid, entry_id FROM history_entries WHERE session_id = ? AND position >= ? ORDER BY position",
        )
        .all(sessionId, position) as SqlRow[];
      const deleteSearch = this.database.prepare("DELETE FROM history_entries_fts WHERE rowid = ?");
      for (const row of removedRows) {
        deleteSearch.run(Number(row.rowid));
      }
      this.database
        .prepare("DELETE FROM history_entries WHERE session_id = ? AND position >= ?")
        .run(sessionId, position);
      const previous = this.database
        .prepare(
          "SELECT entry_id FROM history_entries WHERE session_id = ? ORDER BY position DESC LIMIT 1",
        )
        .get(sessionId) as SqlRow | undefined;
      const afterEntryId = previous ? String(previous.entry_id) : null;
      this.database
        .prepare("UPDATE history_sessions SET updated_at = ? WHERE session_id = ?")
        .run(Date.now(), sessionId);
      if (remote) {
        this.enqueue(remote.endpoint, {
          id: randomUUID(),
          sessionId,
          type: "truncate",
          afterEntryId,
        });
      }
      return afterEntryId;
    });
  }

  async search(input: HistorySearchInput): Promise<HistorySearchResult> {
    const offset = decodeOffsetCursor(input.cursor);
    const values: SqlValue[] = [];
    const attributeClauses = Object.entries(input.attributes ?? {}).map(([key, value]) => {
      values.push(key, value);
      return "EXISTS (SELECT 1 FROM history_attributes a WHERE a.session_id = s.session_id AND a.key = ? AND a.value = ?)";
    });
    const query = input.query?.trim();
    let sql: string;
    if (query) {
      const matchQuery = buildFtsQuery(query);
      values.unshift(matchQuery);
      sql = `
        WITH matches AS (
          SELECT e.session_id,
                 GROUP_CONCAT(SUBSTR(e.search_text, 1, 360), '\n') AS snippets
          FROM history_entries_fts
          JOIN history_entries e ON e.rowid = history_entries_fts.rowid
          WHERE history_entries_fts MATCH ?
          GROUP BY e.session_id
        )
        SELECT s.*, m.snippets
        FROM history_sessions s
        JOIN matches m ON m.session_id = s.session_id
        ${attributeClauses.length > 0 ? `WHERE ${attributeClauses.join(" AND ")}` : ""}
        ORDER BY s.updated_at DESC, s.session_id ASC
        LIMIT ? OFFSET ?`;
    } else {
      sql = `
        SELECT s.*, NULL AS snippets
        FROM history_sessions s
        ${attributeClauses.length > 0 ? `WHERE ${attributeClauses.join(" AND ")}` : ""}
        ORDER BY s.updated_at DESC, s.session_id ASC
        LIMIT ? OFFSET ?`;
    }
    values.push(input.limit + 1, offset);
    const rows = this.database.prepare(sql).all(...values) as SqlRow[];
    const hasMore = rows.length > input.limit;
    const selected = rows.slice(0, input.limit);
    return {
      sessions: selected.map(descriptorFromRow),
      ...(hasMore ? { nextCursor: encodeOffsetCursor(offset + input.limit) } : {}),
    };
  }

  async read(input: HistoryReadInput): Promise<HistoryReadResult> {
    const position = decodePositionCursor(input.cursor);
    const sessionRow = this.database
      .prepare("SELECT *, NULL AS snippets FROM history_sessions WHERE session_id = ?")
      .get(input.sessionId) as SqlRow | undefined;
    if (!sessionRow) {
      throw new Error(`history session '${input.sessionId}' was not found`);
    }
    const rows = this.database
      .prepare(
        "SELECT position, payload_json FROM history_entries WHERE session_id = ? AND position > ? ORDER BY position LIMIT ?",
      )
      .all(input.sessionId, position, input.limit + 1) as SqlRow[];
    const hasMore = rows.length > input.limit;
    const selected = rows.slice(0, input.limit);
    const last = selected.at(-1);
    return {
      session: descriptorFromRow(sessionRow),
      entries: selected.map((row) => JSON.parse(String(row.payload_json)) as HistoryEntry),
      ...(hasMore && last ? { nextCursor: encodePositionCursor(Number(last.position)) } : {}),
    };
  }

  listPendingOperations(endpoint: string, limit: number): PendingReplicationOperation[] {
    return (
      this.database
        .prepare(
          "SELECT id, payload_json FROM history_outbox WHERE endpoint = ? ORDER BY id LIMIT ?",
        )
        .all(endpoint, limit) as SqlRow[]
    ).map((row) => ({
      rowId: Number(row.id),
      operation: JSON.parse(String(row.payload_json)) as HistoryReplicationOperation,
    }));
  }

  acknowledgeOperations(rowIds: number[]): void {
    if (rowIds.length === 0) return;
    this.database
      .prepare(`DELETE FROM history_outbox WHERE id IN (${rowIds.map(() => "?").join(", ")})`)
      .run(...rowIds);
  }

  private initialize(): void {
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS history_sessions (
        session_id TEXT PRIMARY KEY,
        attributes_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        digest_title TEXT,
        digest_summary TEXT,
        digest_through_entry_id TEXT
      );
      CREATE TABLE IF NOT EXISTS history_attributes (
        session_id TEXT NOT NULL REFERENCES history_sessions(session_id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (session_id, key)
      );
      CREATE INDEX IF NOT EXISTS history_attributes_lookup
        ON history_attributes(key, value, session_id);
      CREATE TABLE IF NOT EXISTS history_entries (
        session_id TEXT NOT NULL REFERENCES history_sessions(session_id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        entry_id TEXT NOT NULL,
        type TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        search_text TEXT NOT NULL,
        PRIMARY KEY (session_id, entry_id),
        UNIQUE (session_id, position)
      );
      CREATE INDEX IF NOT EXISTS history_entries_order
        ON history_entries(session_id, position);
      CREATE TABLE IF NOT EXISTS history_entry_sources (
        session_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        PRIMARY KEY (session_id, entry_id, source_id),
        FOREIGN KEY (session_id, entry_id)
          REFERENCES history_entries(session_id, entry_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS history_entry_sources_lookup
        ON history_entry_sources(session_id, source_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS history_entries_fts USING fts5(session_id UNINDEXED, text);
      CREATE TABLE IF NOT EXISTS history_replication_targets (
        session_id TEXT NOT NULL REFERENCES history_sessions(session_id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL,
        PRIMARY KEY (session_id, endpoint)
      );
      CREATE TABLE IF NOT EXISTS history_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        endpoint TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS history_outbox_target ON history_outbox(endpoint, id);
    `);
  }

  private requireSession(sessionId: string): void {
    const row = this.database
      .prepare("SELECT 1 AS found FROM history_sessions WHERE session_id = ?")
      .get(sessionId);
    if (!row) throw new Error(`history session '${sessionId}' was not created`);
  }

  private enqueue(endpoint: string, operation: HistoryReplicationOperation): void {
    this.database
      .prepare("INSERT INTO history_outbox (endpoint, payload_json) VALUES (?, ?)")
      .run(endpoint, JSON.stringify(operation));
  }

  private transaction<T>(handler: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = handler();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function stableJson(value: Record<string, string>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))),
  );
}

function descriptorFromRow(row: SqlRow): HistorySessionDescriptor {
  const title = typeof row.digest_title === "string" ? row.digest_title : undefined;
  const summary = typeof row.digest_summary === "string" ? row.digest_summary : undefined;
  const updatedThroughEntryId =
    typeof row.digest_through_entry_id === "string" ? row.digest_through_entry_id : undefined;
  const rawSnippets = typeof row.snippets === "string" ? row.snippets.split("\n") : [];
  return {
    sessionId: String(row.session_id),
    attributes: JSON.parse(String(row.attributes_json)) as Record<string, string>,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(title && summary && updatedThroughEntryId
      ? { digest: { title, summary, updatedThroughEntryId } }
      : {}),
    snippets: rawSnippets.filter(Boolean).slice(0, MAX_SEARCH_SNIPPETS),
  };
}

function historyEntrySearchText(entry: HistoryEntry): string {
  if (entry.type === "tool") {
    return [entry.name, stringifySearchValue(entry.arguments), stringifySearchValue(entry.result)]
      .filter(Boolean)
      .join("\n");
  }
  return stringifySearchValue(entry.content);
}

function stringifySearchValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(stringifySearchValue).filter(Boolean).join("\n");
  if (typeof value !== "object" || value === null) return "";
  return Object.values(value).map(stringifySearchValue).filter(Boolean).join("\n");
}

function buildFtsQuery(query: string): string {
  const terms = query.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  if (terms.length === 0) return `"${query.replaceAll('"', '""')}"`;
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}

function encodeOffsetCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset })).toString("base64url");
}

function decodeOffsetCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      offset?: unknown;
    };
    if (Number.isSafeInteger(parsed.offset) && Number(parsed.offset) >= 0) {
      return Number(parsed.offset);
    }
  } catch {}
  throw new Error("invalid history search cursor");
}

function encodePositionCursor(position: number): string {
  return Buffer.from(JSON.stringify({ position })).toString("base64url");
}

function decodePositionCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      position?: unknown;
    };
    if (Number.isSafeInteger(parsed.position) && Number(parsed.position) >= 0) {
      return Number(parsed.position);
    }
  } catch {}
  throw new Error("invalid history read cursor");
}
