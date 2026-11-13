import { parseArgs } from "node:util";
import { z } from "zod";
import { createDefaultConfigDeps } from "../config/deps.js";
import { loadHostConfig } from "../config/ownership.js";
import { resolveHistoryRemoteTarget } from "./config.js";
import { historyExportSchema, readHistoryExport, renderHistoryMarkdown } from "./export.js";
import { HistoryManager } from "./history_manager.js";
import { getDefaultHistoryDatabasePath, LocalHistoryStore } from "./local_history_store.js";
import { RemoteHistoryClient } from "./remote_history_client.js";
import { destroyHistoryService, setupHistoryService } from "./setup.js";
import type { HistoryQuery } from "./types.js";

export class HistoryCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryCliError";
  }
}

export function printHistoryHelp(log: (line: string) => void = console.log): void {
  log(
    [
      "usage:",
      "  tau history setup --domain <domain> --zone-name <zone> [--api-key <key>] [--viewer-password <password>]  # Workers Paid",
      "  tau history destroy --yes",
      "  tau history read <id> [--source local|remote] [--format json|markdown-compact|markdown-full]",
      "  tau history read --schema",
      "  tau history status",
      "  tau history retry --session <session-id>",
    ].join("\n"),
  );
}

export async function runHistoryCommand(
  argv: string[],
  options: { env?: NodeJS.ProcessEnv; stdout?: (line: string) => void } = {},
): Promise<void> {
  const stdout = options.stdout ?? console.log;
  const [subcommand, ...args] = argv;
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printHistoryHelp(stdout);
    return;
  }

  try {
    if (subcommand === "read") {
      await runHistoryReadCommand(args, { ...options, stdout });
      return;
    }
    if (subcommand === "status" || subcommand === "retry") {
      let sessionId: string | undefined;
      if (subcommand === "retry" && args.length === 2 && args[0] === "--session") {
        sessionId = args[1];
      } else if (subcommand !== "status" || args.length > 0) {
        throw new Error("use tau history status or tau history retry --session <session-id>");
      }
      if (subcommand === "retry" && !sessionId?.trim()) {
        throw new Error("tau history retry requires a session ID");
      }
      const deps = createDefaultConfigDeps();
      const config = loadHostConfig(process.cwd(), deps);
      if (!config.history) throw new Error("remote history is not configured on this host");
      const endpoint = config.history.endpoint;
      const target = sessionId ? resolveHistoryRemoteTarget(config, options.env) : undefined;
      const store = new LocalHistoryStore(getDefaultHistoryDatabasePath(deps.env.home()));
      let retryFailed = false;
      const manager = new HistoryManager(store, {
        reportReplicationFailure: (diagnostic) => {
          stdout(JSON.stringify(diagnostic));
          if (!diagnostic.quarantined || diagnostic.sessionId === sessionId) retryFailed = true;
        },
      });
      try {
        if (sessionId && target) await manager.retryReplication(target, sessionId);
        const failures = store.listReplicationFailures(endpoint);
        stdout(JSON.stringify({ endpoint, failures }));
        if (
          retryFailed ||
          (sessionId && failures.some((failure) => failure.sessionId === sessionId))
        ) {
          throw new Error("history replication retry did not complete");
        }
      } finally {
        manager.close();
      }
      return;
    }

    if (subcommand === "setup") {
      let domain = options.env?.TAU_HISTORY_DOMAIN;
      let zoneName = options.env?.TAU_HISTORY_ZONE_NAME;
      let apiKey: string | undefined;
      let viewerPassword: string | undefined;
      for (let index = 0; index < args.length; index += 1) {
        const argument = args[index]!;
        if (argument === "--domain" || argument.startsWith("--domain=")) {
          const parsed = parseValue(argument, args, index);
          domain = parsed.value;
          index = parsed.nextIndex;
        } else if (argument === "--zone-name" || argument.startsWith("--zone-name=")) {
          const parsed = parseValue(argument, args, index);
          zoneName = parsed.value;
          index = parsed.nextIndex;
        } else if (argument === "--api-key" || argument.startsWith("--api-key=")) {
          const parsed = parseValue(argument, args, index);
          apiKey = parsed.value;
          index = parsed.nextIndex;
        } else if (argument === "--viewer-password" || argument.startsWith("--viewer-password=")) {
          const parsed = parseValue(argument, args, index);
          viewerPassword = parsed.value;
          index = parsed.nextIndex;
        } else {
          throw new Error(`unknown option: ${argument}`);
        }
      }
      if (!domain || !zoneName) {
        throw new Error("tau history setup requires --domain and --zone-name");
      }
      await setupHistoryService({
        domain,
        zoneName,
        ...(apiKey ? { apiKey } : {}),
        ...(viewerPassword ? { viewerPassword } : {}),
        env: options.env,
        stdout,
      });
      return;
    }

    if (subcommand === "destroy") {
      if (args.some((argument) => argument !== "--yes")) {
        throw new Error(`unknown option: ${args.find((argument) => argument !== "--yes")}`);
      }
      await destroyHistoryService({
        yes: args.includes("--yes"),
        env: options.env,
        stdout,
      });
      return;
    }

    throw new Error(`unknown history subcommand '${subcommand}'`);
  } catch (error) {
    throw new HistoryCliError(error instanceof Error ? error.message : String(error));
  }
}

function parseValue(
  argument: string,
  argv: string[],
  index: number,
): { value: string; nextIndex: number } {
  const equals = argument.indexOf("=");
  if (equals >= 0) {
    const value = argument.slice(equals + 1);
    if (!value) throw new Error(`missing value for ${argument.slice(0, equals)}`);
    return { value, nextIndex: index };
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) throw new Error(`missing value for ${argument}`);
  return { value, nextIndex: index + 1 };
}

export const historyReadHelp = `usage:
  tau history read <id> [--source local|remote] [--format json|markdown-compact|markdown-full]
  tau history read --schema

print the entire recorded transcript of a session.

formats:
  json              default. { session, entries } with recorded payloads, including
                    image data. session.childSessionIds lists direct child sessions,
                    which you can read the same way.
  markdown-compact  conversation text in full, with tool arguments shortened to 256
                    estimated tokens and results to 512, cut from the middle.
  markdown-full     conversation text and tool payloads in full.
both Markdown formats put session metadata in YAML frontmatter and show images
as placeholders.

sources:
  local   default. this host's history database.
  remote  the configured shared history service, without falling back to local.

--schema prints the JSON Schema of the json format, without opening history.
history does not record reasoning, and text that a tool or the remote service
already truncated cannot be restored.

example:
  tau history read <id> | jq '.entries[] | select(.type == "assistant") | .content'`;

export async function runHistoryReadCommand(
  argv: string[],
  options: { env?: NodeJS.ProcessEnv; stdout: (text: string) => void },
): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      schema: { type: "boolean" },
      source: { type: "string" },
      format: { type: "string" },
    },
  });
  if (values.help) {
    options.stdout(historyReadHelp);
    return;
  }
  if (values.schema) {
    if (positionals.length || values.source || values.format)
      throw new Error("--schema cannot be combined with a session, source, or format");
    options.stdout(JSON.stringify(z.toJSONSchema(historyExportSchema), null, 2));
    return;
  }
  if (positionals.length !== 1 || !positionals[0]?.trim())
    throw new Error("tau history read requires one session ID");
  const format = values.format ?? "json";
  const source = values.source ?? "local";
  if (!["json", "markdown-compact", "markdown-full"].includes(format))
    throw new Error("invalid history format");
  if (source !== "local" && source !== "remote")
    throw new Error("history source must be local or remote");
  const deps = createDefaultConfigDeps();
  let manager: HistoryManager | undefined;
  let query: HistoryQuery;
  if (source === "remote") {
    const target = resolveHistoryRemoteTarget(loadHostConfig(process.cwd(), deps), options.env);
    if (!target) throw new Error("remote history is not configured on this host");
    query = new RemoteHistoryClient(target);
  } else {
    manager = HistoryManager.open(getDefaultHistoryDatabasePath(deps.env.home()));
    query = manager.query();
  }
  try {
    const data = await readHistoryExport(query, positionals[0]);
    options.stdout(
      format === "json"
        ? JSON.stringify(data, null, 2)
        : renderHistoryMarkdown(data, format === "markdown-compact").trimEnd(),
    );
  } finally {
    manager?.close();
  }
}
