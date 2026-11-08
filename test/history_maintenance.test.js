import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { expect, it, vi } from "vitest";
import { backfillHistorySearch } from "../dist/core/history/migrations.js";

vi.mock("../dist/history/worker/viewer.js", () => ({ default: "" }));
vi.mock("../dist/history/worker/viewer.css", () => ({ default: "" }));

import historyWorker, { selectDigestCandidate } from "../dist/history/worker/index.js";

const oldSelection = `SELECT s.session_id, s.digest_failure_count
  FROM sessions s
  JOIN entries latest ON latest.session_id = s.session_id
    AND latest.position = (SELECT MAX(position) FROM entries WHERE session_id = s.session_id)
  LEFT JOIN entries digested ON digested.session_id = s.session_id
    AND digested.entry_id = s.digest_through_entry_id
  WHERE (s.digest_through_entry_id IS NULL OR s.digest_through_entry_id != latest.entry_id)
    AND s.updated_at <= ?
    AND (s.digest_next_attempt_at IS NULL OR s.digest_next_attempt_at <= ?)
    AND (s.digest_through_entry_id IS NULL
      OR latest.position - COALESCE(digested.position, 0) >= ?
      OR s.updated_at <= ?)
  ORDER BY COALESCE(s.digest_last_attempt_at, 0), s.updated_at, s.session_id
  LIMIT 1`;

// Workerd exposes the SQLite rows-read counter through Durable Object SQL cursors.
// Local D1's API omits that counter; this runs the same queries on Workerd SQLite.
const measurementWorker = `
  export class Measurement {
    constructor(state) { this.sql = state.storage.sql; }
    async fetch(request) {
      const { query, values = [] } = await request.json();
      const cursor = this.sql.exec(query, ...values);
      const results = [...cursor];
      return Response.json({ results, rowsRead: cursor.rowsRead, rowsWritten: cursor.rowsWritten, databaseSize: this.sql.databaseSize });
    }
  }
  export default {
    fetch(request, env) { return env.DB.get(env.DB.idFromName("measurement")).fetch(request); }
  };
`;

function createMeasurementDatabase() {
  const worker = new Miniflare({
    workers: [
      {
        config: {
          name: "measurement",
          compatibilityDate: "2026-08-01",
          manifest: {
            mainModule: "measurement.mjs",
            modulesRoot: import.meta.dirname,
            modules: { "measurement.mjs": { type: "esm", contents: measurementWorker } },
          },
          env: {
            DB: { type: "durable-object", worker: "measurement", exportName: "Measurement" },
          },
          exports: { Measurement: { type: "durable-object", storage: "sqlite" } },
        },
      },
    ],
  });
  const execute = async (query, values = []) => {
    const response = await worker.dispatchFetch("http://measurement/", {
      method: "POST",
      body: JSON.stringify({ query, values }),
    });
    if (!response.ok) throw new Error(await response.text());
    return await response.json();
  };
  return { worker, execute };
}

it("bounds maintenance reads independently of inactive transcript size", async () => {
  const now = 1_800_000_000_000;
  const measurements = [];
  for (const scale of [1, 10]) {
    const { worker, execute } = createMeasurementDatabase();
    const select = async () => {
      let measured;
      const candidate = await selectDigestCandidate(
        {
          prepare(query) {
            return {
              bind(...values) {
                return {
                  async first() {
                    measured = await execute(query, values);
                    return measured.results[0] ?? null;
                  },
                };
              },
            };
          },
        },
        now,
      );
      return { ...measured, candidate };
    };
    try {
      for (const migration of ["0001_initial", "0002_parent_session"]) {
        await execute(
          readFileSync(
            new URL(`../dist/history/worker/migrations/${migration}.sql`, import.meta.url),
            "utf8",
          ),
        );
      }
      const sessions = 5300 * scale;
      const entries = 218000 * scale;
      await execute(`
        WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < ${sessions})
        INSERT INTO sessions (session_id, attributes_json, created_at, updated_at, digest_through_entry_id)
        SELECT 'session-' || x, '{}', 1, 2, 'entry-' || CASE WHEN x <= ${700 * scale} THEN 42 ELSE 41 END FROM n;
        WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < ${entries})
        INSERT INTO entries (session_id, position, entry_id, timestamp, payload_json, search_text)
        SELECT 'session-' || ((x - 1) % ${sessions} + 1), (x - 1) / ${sessions} + 1,
          'entry-' || ((x - 1) / ${sessions} + 1), 2, '{}', '' FROM n;
      `);
      const oldValues = [now - 600000, now, 8, now - 43200000];
      const beforeIdle = await execute(oldSelection, oldValues);
      await execute(
        readFileSync(
          new URL("../dist/history/worker/migrations/0003_digest_schedule.sql", import.meta.url),
          "utf8",
        ),
      );
      const afterIdle = await select();
      expect(beforeIdle.results).toEqual([]);
      expect(afterIdle.candidate).toBeUndefined();
      expect(afterIdle.rowsRead).toBeLessThanOrEqual(4);

      // A small due set among both current and not-yet-due sessions.
      await execute(`UPDATE sessions SET digest_through_entry_id = NULL
        WHERE session_id IN ('session-1', 'session-2', 'session-3');
        UPDATE sessions SET digest_through_entry_id = 'entry-40', updated_at = ${now - 600001}
        WHERE session_id IN ('session-4', 'session-5');`);
      const beforeActive = await execute(oldSelection, oldValues);
      const afterActive = await select();
      expect(afterActive.candidate?.sessionId).toBe(beforeActive.results[0].session_id);
      expect(afterActive.rowsRead).toBeLessThanOrEqual(12);
      expect(beforeActive.rowsRead).toBeGreaterThan(entries);
      const plan = await execute(
        "EXPLAIN QUERY PLAN SELECT session_id FROM sessions WHERE digest_due_at <= ?",
        [now],
      );
      expect(plan.results.some((row) => row.detail.includes("sessions_digest_due"))).toBe(true);
      const update = await execute(
        "UPDATE sessions SET transcript_revision = transcript_revision + 1 WHERE session_id = 'session-1'",
      );
      expect(update.rowsRead).toBeLessThanOrEqual(16);
      measurements.push({
        scheduleUpdate: update.rowsRead,
        sessions,
        entries,
        beforeIdle: beforeIdle.rowsRead,
        afterIdle: afterIdle.rowsRead,
        beforeActive: beforeActive.rowsRead,
        afterActive: afterActive.rowsRead,
      });
    } finally {
      await worker.dispose();
    }
  }
  console.log("history maintenance rows read", JSON.stringify(measurements));
}, 120_000);

it("migrates external-content search on Workerd without keeping a second text copy", async () => {
  const { worker, execute } = createMeasurementDatabase();
  try {
    for (const migration of [
      "0001_initial",
      "0002_parent_session",
      "0003_digest_schedule",
      "0004_recent_sessions",
    ]) {
      await execute(
        readFileSync(
          new URL(`../dist/history/worker/migrations/${migration}.sql`, import.meta.url),
          "utf8",
        ),
      );
    }
    await execute(`
      INSERT INTO sessions (session_id, attributes_json, created_at, updated_at)
      VALUES ('selected', '{}', 1, 1);
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 2000)
      INSERT INTO entries (session_id, position, entry_id, timestamp, payload_json, search_text)
      SELECT 'selected', x, 'entry-' || x, 1, '{}', replace(hex(zeroblob(2000)), '00', 'prefix ') || 'needle phrase' FROM n;
      INSERT INTO entries_fts (session_id, entry_id, position, text)
      SELECT session_id, entry_id, position, search_text FROM entries ORDER BY position DESC;
    `);
    const usedBytes = async () => (await execute("SELECT 1")).databaseSize;
    const before = await usedBytes();
    await execute(
      readFileSync(
        new URL("../dist/history/worker/migrations/0005_external_content.sql", import.meta.url),
        "utf8",
      ),
    );
    await backfillHistorySearch(
      async (sql) => (await execute(sql)).results,
      () => {},
    );
    await execute(
      readFileSync(
        new URL(
          "../dist/history/worker/migrations/0006_external_content_cutover.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const after = await usedBytes();
    expect(after).toBeLessThan(before * 0.75);
    expect(
      (await execute("SELECT name FROM sqlite_master WHERE name = 'entries_search_fts_content'"))
        .results,
    ).toEqual([]);
    const matches =
      await execute(`SELECT rowid, entry_id, snippet(entries_search_fts, 3, '', '', '…', 4) AS excerpt
      FROM entries_search_fts WHERE entries_search_fts MATCH '"needle phrase"' ORDER BY rowid LIMIT 2`);
    expect(matches.results.map((row) => row.entry_id)).toEqual(["entry-1", "entry-2"]);
    expect(matches.results.every((row) => row.excerpt.includes("needle phrase"))).toBe(true);
    const deletion = await execute(
      "DELETE FROM entries WHERE session_id = 'selected' AND position > 1998",
    );
    expect(deletion.rowsRead).toBeLessThan(100);
    expect(
      (
        await execute(
          "SELECT COUNT(*) AS count FROM entries_search_fts WHERE entries_search_fts MATCH 'needle'",
        )
      ).results[0].count,
    ).toBe(1998);
    await execute("UPDATE entries SET search_text = 'changed phrase' WHERE position = 1");
    expect(
      (
        await execute(
          "SELECT entry_id FROM entries_search_fts WHERE entries_search_fts MATCH 'changed'",
        )
      ).results,
    ).toEqual([{ entry_id: "entry-1" }]);
    await execute(
      "INSERT INTO entries_search_fts(entries_search_fts, rank) VALUES ('integrity-check', 1)",
    );
    await execute("UPDATE sessions SET transcript_revision = transcript_revision + 1");
    expect((await execute("SELECT digest_due_at FROM sessions")).results[0].digest_due_at).toBe(
      600001,
    );
    console.log("history external-content used bytes", JSON.stringify({ before, after }));
  } finally {
    await worker.dispose();
  }
}, 30_000);

it("bounds snippet payloads without adding a second full-text scan", async () => {
  const { worker, execute } = createMeasurementDatabase();
  try {
    for (const migration of [
      "0001_initial",
      "0002_parent_session",
      "0003_digest_schedule",
      "0004_recent_sessions",
      "0005_external_content",
      "0006_external_content_cutover",
    ]) {
      await execute(
        readFileSync(
          new URL(`../dist/history/worker/migrations/${migration}.sql`, import.meta.url),
          "utf8",
        ),
      );
    }
    const entries = 10000;
    await execute(`
      INSERT INTO sessions (session_id, attributes_json, created_at, updated_at)
      VALUES ('selected', '{}', 1, 1);
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < ${entries})
      INSERT INTO entries (session_id, entry_id, position, search_text, timestamp, payload_json)
      SELECT CASE WHEN x <= 41 THEN 'selected' ELSE 'other' END, 'entry-' || x, x, 'needle', 1, '{}' FROM n;
    `);
    await execute("UPDATE entries SET search_text = ? WHERE position <= 3", [
      `${"prefix ".repeat(30000)}needle ${"suffix ".repeat(30000)}`,
    ]);
    let snippets;
    const response = await historyWorker.fetch(
      new Request("https://history.example.com/v1/search", {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify({ query: "needle" }),
      }),
      {
        API_KEY: "secret",
        DB: {
          prepare(query) {
            return {
              bind(...values) {
                return {
                  async all() {
                    const measured = await execute(query, values);
                    if (query.includes("WITH ranked_snippets")) snippets = measured;
                    return measured;
                  },
                };
              },
            };
          },
        },
      },
      {},
    );
    expect(response.status).toBe(200);
    const { sessions } = await response.json();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].snippets).toHaveLength(3);
    expect(snippets.rowsRead).toBeLessThan(entries + 500);
    expect(snippets.results).toHaveLength(3);
    for (const row of snippets.results) {
      expect(row.match_text).toContain("needle");
      expect(Buffer.byteLength(row.match_text)).toBeLessThanOrEqual(1440);
    }
  } finally {
    await worker.dispose();
  }
}, 30_000);
