-- Preserve the old rowids as explicit keys so maintenance cannot renumber FTS documents.
CREATE TABLE entries_external (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  entry_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  search_text TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE (session_id, entry_id),
  UNIQUE (session_id, position)
);
CREATE VIEW entries_search AS
SELECT id, session_id, entry_id, position, search_text AS text FROM entries_external;
CREATE VIRTUAL TABLE entries_search_fts USING fts5(
  session_id UNINDEXED,
  entry_id UNINDEXED,
  position UNINDEXED,
  text,
  content='entries_search',
  content_rowid='id'
);

CREATE TRIGGER entries_search_insert AFTER INSERT ON entries_external BEGIN
  INSERT INTO entries_search_fts(rowid, session_id, entry_id, position, text)
  VALUES (new.id, new.session_id, new.entry_id, new.position, new.search_text);
END;
CREATE TRIGGER entries_search_delete AFTER DELETE ON entries_external BEGIN
  INSERT INTO entries_search_fts(entries_search_fts, rowid, session_id, entry_id, position, text)
  VALUES ('delete', old.id, old.session_id, old.entry_id, old.position, old.search_text);
END;
CREATE TRIGGER entries_search_update
AFTER UPDATE OF id, session_id, entry_id, position, search_text ON entries_external BEGIN
  INSERT INTO entries_search_fts(entries_search_fts, rowid, session_id, entry_id, position, text)
  VALUES ('delete', old.id, old.session_id, old.entry_id, old.position, old.search_text);
  INSERT INTO entries_search_fts(rowid, session_id, entry_id, position, text)
  VALUES (new.id, new.session_id, new.entry_id, new.position, new.search_text);
END;

-- Mirror live writes while setup copies historical entries in bounded batches.
CREATE TRIGGER entries_external_insert AFTER INSERT ON entries BEGIN
  INSERT INTO entries_external (id, session_id, position, entry_id, timestamp, payload_json, search_text)
  VALUES (new.rowid, new.session_id, new.position, new.entry_id, new.timestamp, new.payload_json, new.search_text);
END;
CREATE TRIGGER entries_external_delete AFTER DELETE ON entries BEGIN
  DELETE FROM entries_external WHERE id = old.rowid;
END;
CREATE TRIGGER entries_external_update AFTER UPDATE ON entries BEGIN
  DELETE FROM entries_external WHERE id = old.rowid;
  INSERT INTO entries_external (id, session_id, position, entry_id, timestamp, payload_json, search_text)
  VALUES (new.rowid, new.session_id, new.position, new.entry_id, new.timestamp, new.payload_json, new.search_text);
END;
CREATE TABLE history_search_backfill (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  through_rowid INTEGER NOT NULL
);
INSERT INTO history_search_backfill VALUES (1, 0);
