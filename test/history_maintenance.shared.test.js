import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { expect, it } from "vitest";
import { backfillHistorySearch } from "../dist/core/history/migrations.js";

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
