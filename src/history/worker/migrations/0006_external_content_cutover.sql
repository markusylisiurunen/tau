-- Refuse cutover if setup has not copied every surviving transcript entry.
CREATE TABLE history_search_ready (ready INTEGER CHECK (ready = 1));
INSERT INTO history_search_ready
SELECT NOT EXISTS (
  SELECT 1 FROM entries e LEFT JOIN entries_external n ON n.id = e.rowid
  WHERE n.id IS NULL
);
DROP TABLE history_search_ready;

DROP TRIGGER sessions_digest_schedule;
DROP TRIGGER entries_external_insert;
DROP TRIGGER entries_external_delete;
DROP TRIGGER entries_external_update;
DROP TABLE entries_fts;
DROP TABLE entries;
ALTER TABLE entries_external RENAME TO entries;
CREATE INDEX entries_order ON entries(session_id, position);
DROP TABLE history_search_backfill;

CREATE TRIGGER sessions_digest_schedule
AFTER UPDATE OF updated_at, transcript_revision, digest_through_entry_id, digest_next_attempt_at
ON sessions
BEGIN
  UPDATE sessions
  SET digest_due_at = (
    SELECT CASE
      WHEN NEW.digest_through_entry_id = latest.entry_id THEN NULL
      ELSE MAX(
        COALESCE(NEW.digest_next_attempt_at, 0),
        NEW.updated_at + CASE
          WHEN NEW.digest_through_entry_id IS NULL
            OR latest.position - COALESCE(digested.position, 0) >= 8
          THEN 600000
          ELSE 43200000
        END
      )
    END
    FROM entries latest
    LEFT JOIN entries digested ON digested.session_id = NEW.session_id
      AND digested.entry_id = NEW.digest_through_entry_id
    WHERE latest.session_id = NEW.session_id
      AND latest.position = (SELECT MAX(position) FROM entries WHERE session_id = NEW.session_id)
  )
  WHERE session_id = NEW.session_id;
END;
