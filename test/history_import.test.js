import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const cli = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const session = { sessionId: "external:example", attributes: { source: "example" }, createdAt: 1 };
const first = { type: "user", id: "1", sourceIds: ["1"], timestamp: 1, content: "hello" };
const second = { type: "assistant", id: "2", sourceIds: ["2"], timestamp: 2, content: "hi" };

it("imports before an upload is possible, retries its outbox, and appends on resume without duplicates", async () => {
  const home = await mkdtemp(join(tmpdir(), "tau-history-import-"));
  const calls = [];
  let online = false;
  const remote = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    calls.push(JSON.parse(body).operations);
    response.writeHead(online ? 200 : 503, { "content-type": "application/json" });
    response.end(
      online ? '{"applied":1}' : '{"error":{"code":"internal_error","message":"offline"}}',
    );
  });
  const run = (args, input) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [cli, "history", ...args],
        {
          cwd: home,
          maxBuffer: 2 * 1024 * 1024,
          env: { ...process.env, HOME: home, TAU_OFFLINE: "1", TAU_HISTORY_API_KEY: "test" },
        },
        (error, stdout, stderr) => {
          if (error) reject(error);
          else resolve({ data: JSON.parse(stdout), stderr });
        },
      );
      child.stdin.on("error", reject);
      child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
    });
  const ingest = (data) => run(["import", "--require-remote"], data);
  try {
    await expect(ingest([{ session, entries: [first] }])).rejects.toThrow(
      "remote history is not configured",
    );
    for (const sessionId of [" ", " example", "example\n"]) {
      await expect(
        run(["import"], [{ session: { ...session, sessionId }, entries: [first] }]),
      ).rejects.toThrow();
    }
    const protoRecord = { ["__proto__"]: "example" };
    const tool = {
      id: first.id,
      sourceIds: first.sourceIds,
      timestamp: first.timestamp,
      type: "tool",
      name: "example",
      arguments: {},
      result: {},
      outcome: "succeeded",
    };
    for (const invalid of [
      { session: { ...session, attributes: protoRecord }, entries: [first] },
      { session, entries: [{ ...tool, arguments: protoRecord }] },
      { session, entries: [{ ...tool, result: protoRecord }] },
    ]) {
      await expect(run(["import"], [invalid])).rejects.toThrow();
    }
    const oversized = { ...first, sourceIds: Array(2100).fill("x".repeat(512)) };
    const localSession = { ...session, sessionId: "external:local" };
    expect(
      (await run(["import"], [{ session: localSession, entries: [oversized] }])).data.appended,
    ).toBe(1);

    await new Promise((resolve) => remote.listen(0, "127.0.0.1", resolve));
    const configDir = join(home, ".config", "tau");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "config.json"),
      JSON.stringify({
        history: { endpoint: `http://127.0.0.1:${remote.address().port}` },
      }),
    );

    await expect(ingest([{ session, entries: [first, first] }])).rejects.toThrow(
      "duplicate entry ID",
    );
    await expect(ingest([{ session, entries: [oversized] }])).rejects.toThrow(
      "cannot fit the remote entry limit",
    );
    expect(calls).toEqual([]);
    expect(await ingest([{ session, entries: [first] }])).toMatchObject({
      data: { sessions: 1, appended: 1 },
      stderr: expect.stringContaining("history_replication_failed"),
    });
    expect((await run(["read", session.sessionId])).data.entries).toEqual([first]);

    online = true;
    const offlineOperations = calls[0];
    await ingest([]);
    expect(calls[1]).toEqual(offlineOperations);
    expect(offlineOperations.map(({ type }) => type)).toEqual(["create", "append"]);
    expect((await ingest([{ session, entries: [first, second] }])).data.appended).toBe(1);
    expect(calls[2]).toMatchObject([{ type: "append", entries: [second] }]);
    const { data: transcript } = await run(["read", session.sessionId]);
    expect(transcript.entries).toEqual([first, second]);
    expect(transcript.session.updatedAt).toBe(second.timestamp);
    expect((await ingest([{ session, entries: [first, second] }])).data.appended).toBe(0);
    expect(calls).toHaveLength(3);

    expect(
      (await ingest([{ session: localSession, entries: [oversized, second] }])).data.appended,
    ).toBe(1);
    expect(calls[3].flatMap((operation) => operation.entries ?? [])).toEqual([second]);
    expect((await run(["read", localSession.sessionId])).data.entries).toEqual([oversized, second]);
  } finally {
    await new Promise((resolve) => remote.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
}, 40_000);
