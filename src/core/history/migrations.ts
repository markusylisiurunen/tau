export const HISTORY_MIGRATION_NAMES = [
  "0001_initial.sql",
  "0002_parent_session.sql",
  "0003_digest_schedule.sql",
  "0004_recent_sessions.sql",
  "0005_external_content.sql",
  "0006_external_content_cutover.sql",
] as const;

export const HISTORY_SEARCH_CUTOVER_MIGRATION = "0006_external_content_cutover.sql";

export async function backfillHistorySearch(
  execute: (sql: string) => Promise<Record<string, unknown>[]>,
  stdout: (line: string) => void,
): Promise<void> {
  const pending = await execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'history_search_backfill'",
  );
  if (pending.length === 0) return;
  const [state] = await execute(
    "SELECT through_rowid FROM history_search_backfill WHERE singleton = 1",
  );
  if (!state) throw new Error("missing history search migration cursor");
  let through = Number(state.through_rowid);
  if (!Number.isSafeInteger(through) || through < 0)
    throw new Error("invalid history search migration cursor");
  for (;;) {
    const rows = await execute(
      `SELECT rowid AS id, length(CAST(payload_json AS BLOB)) + length(CAST(search_text AS BLOB)) AS bytes
       FROM entries WHERE rowid > ${through} ORDER BY rowid LIMIT 512`,
    );
    if (rows.length === 0) break;
    let end = through;
    let bytes = 0;
    for (const row of rows) {
      if (end > through && bytes + Number(row.bytes) > 32 * 1024 * 1024) break;
      const id = Number(row.id);
      if (!Number.isSafeInteger(id) || id <= end)
        throw new Error("invalid history search migration entry ID");
      end = id;
      bytes += Number(row.bytes);
    }
    // The copy and cursor are separate statements. Repeating a committed copy is safe.
    // Live-write triggers keep already-copied rows current between requests.
    await execute(
      `INSERT INTO entries_external (id, session_id, position, entry_id, timestamp, payload_json, search_text)
       SELECT rowid, session_id, position, entry_id, timestamp, payload_json, search_text
       FROM entries WHERE rowid > ${through} AND rowid <= ${end}
       ON CONFLICT(id) DO NOTHING`,
    );
    await execute(
      `UPDATE history_search_backfill SET through_rowid = MAX(through_rowid, ${end}) WHERE singleton = 1`,
    );
    through = end;
    stdout(`copied history search through entry ${through}`);
  }
}
