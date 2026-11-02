ALTER TABLE sessions ADD COLUMN parent_session_id TEXT;
CREATE INDEX IF NOT EXISTS sessions_parent ON sessions(parent_session_id)
  WHERE parent_session_id IS NOT NULL;
