import { ReadStream } from "node:tty";
import { parseArgs } from "node:util";
import { z } from "zod";
import { createDefaultConfigDeps } from "../config/deps.js";
import { loadHostConfig } from "../config/ownership.js";
import { resolveHistoryRemoteTarget } from "./config.js";
import { HistoryManager } from "./history_manager.js";
import { getDefaultHistoryDatabasePath, LocalHistoryStore } from "./local_history_store.js";
import { HISTORY_REMOTE_ENTRY_MAX_BYTES, projectHistoryEntryForRemote } from "./replication.js";
import { historyEntrySchema } from "./schema.js";

const entryId = z.string().min(1).max(512);
const timestamp = z.number().nonnegative().max(8.64e15);
const sessionId = z.string().min(1).max(256);
const importEntrySchema = historyEntrySchema.and(
  z.object({ id: entryId, sourceIds: z.array(entryId).min(1), timestamp }),
);
const historyImportSchema = z.array(
  z.strictObject({
    session: z.strictObject({
      sessionId,
      createdAt: timestamp,
      attributes: z
        .record(z.string().min(1).max(64), z.string().max(1024))
        .refine((value) => Object.keys(value).length <= 32, "at most 32 attributes are allowed")
        .meta({ maxProperties: 32 }),
    }),
    entries: z.array(importEntrySchema),
  }),
);

const help = `usage:
  tau history import [--require-remote] < transcripts.json
  tau history import --schema

append normalized transcripts from a JSON array on stdin. use stable session and
entry IDs. the session's creation time and attributes are immutable. existing
entry IDs are skipped, and new entries are appended in input order.

with remote history configured, new entries are queued for replication. an empty
array retries pending uploads. a successful import confirms the local write.
--require-remote fails before writing if remote history is not configured.`;

export async function runHistoryImportCommand(
  argv: string[],
  options: { env?: NodeJS.ProcessEnv; stdout: (text: string) => void },
): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      schema: { type: "boolean" },
      "require-remote": { type: "boolean" },
    },
  });
  if (values.help) {
    options.stdout(help);
    return;
  }
  if (values.schema) {
    options.stdout(JSON.stringify(z.toJSONSchema(historyImportSchema), null, 2));
    return;
  }
  if (process.stdin instanceof ReadStream && process.stdin.isTTY)
    throw new Error("tau history import requires JSON on stdin");
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  let data: unknown;
  try {
    data = JSON.parse(input);
  } catch {
    throw new Error("history import input is not valid JSON");
  }
  const parsed = historyImportSchema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new Error(
      `invalid history import at ${issue.path.join(".") || "stdin"}: ${issue.message}`,
    );
  }
  const ids = new Set<string>();
  for (const { session, entries } of parsed.data) {
    if (ids.has(session.sessionId)) throw new Error("duplicate session ID in history import");
    ids.add(session.sessionId);
    if (new Set(entries.map(({ id }) => id)).size !== entries.length)
      throw new Error("duplicate entry ID in history import");
  }

  const deps = createDefaultConfigDeps();
  const target = resolveHistoryRemoteTarget(loadHostConfig(process.cwd(), deps), options.env);
  if (values["require-remote"] && !target)
    throw new Error("remote history is not configured on this host");
  if (target) {
    for (const { session, entries } of parsed.data) {
      for (const entry of entries) {
        if (
          Buffer.byteLength(JSON.stringify(entry)) > HISTORY_REMOTE_ENTRY_MAX_BYTES &&
          Buffer.byteLength(JSON.stringify(projectHistoryEntryForRemote(entry))) >
            HISTORY_REMOTE_ENTRY_MAX_BYTES
        ) {
          throw new Error(
            `history import entry '${entry.id}' in session '${session.sessionId}' cannot fit the remote entry limit`,
          );
        }
      }
    }
  }
  const store = new LocalHistoryStore(getDefaultHistoryDatabasePath(deps.env.home()));
  const reported = new Set<string>();
  const manager = new HistoryManager(store, {
    reportReplicationFailure: (diagnostic) => {
      if (diagnostic.quarantined && diagnostic.sessionId) reported.add(diagnostic.sessionId);
      console.error(JSON.stringify(diagnostic));
    },
  });
  let appended = 0;
  try {
    for (const { session, entries } of parsed.data) {
      store.createSession(session, target);
      // Keep each SQLite statement below its parameter limit.
      for (let index = 0; index < entries.length; index += 250) {
        appended += store.append(session.sessionId, entries.slice(index, index + 250), target, {
          preserveTimestamps: true,
        }).length;
      }
    }
    if (target) {
      await manager.syncReplication(target);
      for (const failure of store.listReplicationFailures(target.endpoint)) {
        if (!reported.has(failure.sessionId)) {
          console.error(
            JSON.stringify({ event: "history_replication_failed", quarantined: true, ...failure }),
          );
        }
      }
    }
    options.stdout(JSON.stringify({ sessions: parsed.data.length, appended }));
  } finally {
    manager.close();
  }
}
