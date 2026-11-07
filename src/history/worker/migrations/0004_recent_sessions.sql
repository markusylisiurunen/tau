CREATE INDEX sessions_recent ON sessions(updated_at DESC, session_id ASC);
