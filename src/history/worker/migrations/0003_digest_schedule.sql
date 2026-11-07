ALTER TABLE sessions ADD COLUMN digest_due_at INTEGER;

CREATE INDEX sessions_digest_due ON sessions(digest_due_at)
WHERE digest_due_at IS NOT NULL;

-- Replication changes entries before updating the session in the same transaction.
-- Only that session's indexed head and digest boundary are read here.
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

-- Discover existing work once, including sessions already waiting for a retry.
UPDATE sessions SET updated_at = updated_at;
