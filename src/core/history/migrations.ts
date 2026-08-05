export const HISTORY_INITIAL_MIGRATION_NAME = "0001_initial.sql";

export const HISTORY_INITIAL_MIGRATION_SQL = `CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  attributes_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  transcript_revision INTEGER NOT NULL DEFAULT 0,
  digest_title TEXT,
  digest_summary TEXT,
  digest_through_entry_id TEXT,
  digest_failure_count INTEGER NOT NULL DEFAULT 0,
  digest_next_attempt_at INTEGER,
  digest_last_attempt_at INTEGER,
  digest_last_success_at INTEGER,
  digest_last_error TEXT
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
CREATE TABLE IF NOT EXISTS digest_worker_lease (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  claimed_at INTEGER
);
INSERT OR IGNORE INTO digest_worker_lease (singleton, claimed_at) VALUES (1, NULL);
`;
