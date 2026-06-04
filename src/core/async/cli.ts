import { z } from "zod";
import { createDefaultConfigDeps } from "../config/deps.js";
import type { Config } from "../config/schema.js";
import { getGoogleApiKey, getMistralApiKey, loadConfig } from "../config/schema.js";
import { AsyncDaemonRuntimeError, startAsyncDaemonRuntime } from "./daemon_runtime.js";
import { AsyncDaemonConfigError, loadAsyncDaemonConfig } from "./server_config.js";
import { createAsyncSessionManager } from "./session_manager.js";
import { cleanupWorkspaceRootsOnStartup } from "./workspace.js";

export class AsyncCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AsyncCliError";
  }
}

type ParsedAsyncSharedArgs = {
  help: boolean;
  projectId?: string;
  targetId?: string;
  url?: string;
  token?: string;
  configFilePath?: string;
};

type ParsedAsyncArgs =
  | (ParsedAsyncSharedArgs & {
      command: "create";
      prompt: string;
    })
  | (ParsedAsyncSharedArgs & {
      command: "daemon";
    })
  | (ParsedAsyncSharedArgs & {
      command: "list";
    })
  | (ParsedAsyncSharedArgs & {
      command: "status";
      sessionId: string;
    })
  | (ParsedAsyncSharedArgs & {
      command: "logs";
      sessionId: string;
    })
  | (ParsedAsyncSharedArgs & {
      command: "send";
      sessionId: string;
      text: string;
    })
  | (ParsedAsyncSharedArgs & {
      command: "interrupt";
      sessionId: string;
    })
  | (ParsedAsyncSharedArgs & {
      command: "cron-list";
    })
  | (ParsedAsyncSharedArgs & {
      command: "cron-runs";
      cronJobId?: string;
    })
  | (ParsedAsyncSharedArgs & {
      command: "cron-run";
      cronJobId: string;
    });

export type RunAsyncCommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  config?: Config;
  fetchImpl?: typeof fetch;
  stdout?: (line: string) => void;
};

type ResolvedTarget = {
  url: string;
  token: string;
  timeoutMs?: number;
};

const AsyncOptionNames = ["project", "target", "url", "token", "config-file"] as const;
type AsyncOptionName = (typeof AsyncOptionNames)[number];
const AsyncOptionNameSet = new Set<string>(AsyncOptionNames);

const CronSubcommands = new Set<string>(["list", "runs", "run"]);

function requireTrimmedValue(value: string | undefined, message: string): string {
  if (typeof value !== "string") {
    throw new AsyncCliError(message);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new AsyncCliError(message);
  }

  return trimmed;
}

function parsePromptText(tokens: string[], message: string): string {
  const prompt = tokens.join(" ").trim();
  if (!prompt) {
    throw new AsyncCliError(message);
  }

  return prompt;
}

function parseLongOptionToken(arg: string): {
  name: AsyncOptionName;
  flag: string;
  inlineValue?: string;
} {
  const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
  if (!match) {
    throw new AsyncCliError(`unknown option: ${arg}`);
  }

  const name = match[1] ?? "";
  if (!AsyncOptionNameSet.has(name)) {
    throw new AsyncCliError(`unknown option: ${arg}`);
  }

  return {
    name: name as AsyncOptionName,
    flag: `--${name}`,
    inlineValue: match[2],
  };
}

function parseValue(args: { flag: string; inlineValue?: string; argv: string[]; index: number }): {
  value: string;
  nextIndex: number;
} {
  if (args.inlineValue !== undefined) {
    const value = requireTrimmedValue(args.inlineValue, `missing value for ${args.flag}`);
    return { value, nextIndex: args.index };
  }

  const next = args.argv[args.index + 1];
  if (!next || next.startsWith("-")) {
    throw new AsyncCliError(`missing value for ${args.flag}`);
  }

  const value = requireTrimmedValue(next, `missing value for ${args.flag}`);
  return { value, nextIndex: args.index + 1 };
}

function parseAsyncArgs(argv: string[]): ParsedAsyncArgs {
  let help = false;
  let projectId: string | undefined;
  let targetId: string | undefined;
  let url: string | undefined;
  let token: string | undefined;
  let configFilePath: string | undefined;
  let forcePrompt = false;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;

    if (forcePrompt) {
      positional.push(arg);
      continue;
    }

    if (arg === "--") {
      forcePrompt = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg.startsWith("-")) {
      const optionToken = parseLongOptionToken(arg);
      const parsed = parseValue({
        flag: optionToken.flag,
        inlineValue: optionToken.inlineValue,
        argv,
        index: i,
      });
      i = parsed.nextIndex;

      switch (optionToken.name) {
        case "project":
          projectId = parsed.value;
          break;
        case "target":
          targetId = parsed.value;
          break;
        case "url":
          url = parsed.value;
          break;
        case "token":
          token = parsed.value;
          break;
        case "config-file":
          configFilePath = parsed.value;
          break;
      }
      continue;
    }

    positional.push(arg);
  }

  const shared: ParsedAsyncSharedArgs = {
    help,
    ...(projectId === undefined ? {} : { projectId }),
    ...(targetId === undefined ? {} : { targetId }),
    ...(url === undefined ? {} : { url }),
    ...(token === undefined ? {} : { token }),
    ...(configFilePath === undefined ? {} : { configFilePath }),
  };

  const toCreateArgs = (): ParsedAsyncArgs => ({
    ...shared,
    command: "create",
    prompt: parsePromptText(positional, "missing prompt text"),
  });

  const first = positional[0];
  if (!first) {
    if (shared.help) {
      return { ...shared, command: "list" };
    }
    throw new AsyncCliError("missing async command or prompt");
  }

  if (forcePrompt) {
    return toCreateArgs();
  }

  if (first === "daemon") {
    if (positional.length === 1) {
      return { ...shared, command: "daemon" };
    }
    return toCreateArgs();
  }

  if (first === "list") {
    if (positional.length === 1) {
      return { ...shared, command: "list" };
    }
    return toCreateArgs();
  }

  if (first === "status") {
    if (positional.length === 1) {
      throw new AsyncCliError("missing session id for status");
    }

    if (positional.length === 2) {
      return {
        ...shared,
        command: "status",
        sessionId: requireTrimmedValue(positional[1], "missing session id for status"),
      };
    }

    return toCreateArgs();
  }

  if (first === "logs") {
    if (positional.length === 1) {
      throw new AsyncCliError("missing session id for logs");
    }

    if (positional.length === 2) {
      return {
        ...shared,
        command: "logs",
        sessionId: requireTrimmedValue(positional[1], "missing session id for logs"),
      };
    }

    return toCreateArgs();
  }

  if (first === "send") {
    const sessionId = requireTrimmedValue(positional[1], "missing session id for send");

    if (positional.length === 2) {
      throw new AsyncCliError("missing message text for send");
    }

    return {
      ...shared,
      command: "send",
      sessionId,
      text: parsePromptText(positional.slice(2), "missing message text for send"),
    };
  }

  if (first === "interrupt") {
    if (positional.length === 1) {
      throw new AsyncCliError("missing session id for interrupt");
    }

    if (positional.length === 2) {
      return {
        ...shared,
        command: "interrupt",
        sessionId: requireTrimmedValue(positional[1], "missing session id for interrupt"),
      };
    }

    return toCreateArgs();
  }

  if (first === "cron") {
    const missingCronSubcommandMessage =
      "missing cron subcommand. use: cron list | cron runs [jobId] | cron run <jobId>";
    const subcommandRaw = requireTrimmedValue(positional[1], missingCronSubcommandMessage);

    if (!CronSubcommands.has(subcommandRaw)) {
      throw new AsyncCliError(`unknown cron subcommand '${subcommandRaw}'`);
    }

    if (subcommandRaw === "list") {
      if (positional.length !== 2) {
        throw new AsyncCliError("usage: tau async cron list");
      }

      return {
        ...shared,
        command: "cron-list",
      };
    }

    if (subcommandRaw === "runs") {
      if (positional.length > 3) {
        throw new AsyncCliError("usage: tau async cron runs [jobId]");
      }

      const cronJobId =
        positional.length === 3
          ? requireTrimmedValue(positional[2], "usage: tau async cron runs [jobId]")
          : undefined;

      return {
        ...shared,
        command: "cron-runs",
        ...(cronJobId === undefined ? {} : { cronJobId }),
      };
    }

    const cronJobId = requireTrimmedValue(positional[2], "missing cron job id for run");

    if (positional.length !== 3) {
      throw new AsyncCliError("usage: tau async cron run <jobId>");
    }

    return {
      ...shared,
      command: "cron-run",
      cronJobId,
    };
  }

  return toCreateArgs();
}

function getTrimmedEnvValue(key: string, env: NodeJS.ProcessEnv): string | undefined {
  const value = env[key];
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function collectDaemonWorkspaceRoots(
  daemonConfig: ReturnType<typeof loadAsyncDaemonConfig>,
): string[] {
  const roots = new Set<string>([daemonConfig.workspaceRoot]);

  for (const project of Object.values(daemonConfig.projects)) {
    if (project.workspaceRoot) {
      roots.add(project.workspaceRoot);
    }
  }

  return Array.from(roots);
}

function logStartupCleanupSummary(args: {
  stdout: (line: string) => void;
  results: Awaited<ReturnType<typeof cleanupWorkspaceRootsOnStartup>>;
}): void {
  for (const result of args.results) {
    if (result.deletedEntries > 0) {
      args.stdout(
        `[daemon:info] startup workspace cleanup removed ${result.deletedEntries} entries under ${result.workspaceRoot}`,
      );
    }

    for (const failure of result.failures) {
      args.stdout(
        `[daemon:warn] startup workspace cleanup failed for ${failure.path}: ${failure.cause}`,
      );
    }
  }
}

function resolveProjectId(args: ParsedAsyncArgs, config: Config): string {
  const configured = config.async?.client?.defaultProjectId?.trim();
  const projectId = args.projectId ?? (configured || undefined);
  if (!projectId) {
    throw new AsyncCliError(
      "missing project id. use --project <id> or set async.client.defaultProjectId",
    );
  }

  return projectId;
}

function resolveTarget(config: Config, args: ParsedAsyncArgs): ResolvedTarget {
  const targets = config.async?.client?.targets ?? {};
  const configuredDefault = config.async?.client?.defaultTarget;
  const targetIds = Object.keys(targets);

  let selectedTargetId = args.targetId;
  if (!selectedTargetId && (args.url === undefined || args.token === undefined)) {
    selectedTargetId = configuredDefault ?? (targetIds.length === 1 ? targetIds[0] : undefined);
  }

  const selectedTarget = selectedTargetId ? targets[selectedTargetId] : undefined;
  if (selectedTargetId && !selectedTarget) {
    throw new AsyncCliError(`unknown async target '${selectedTargetId}'`);
  }

  const url = args.url ?? selectedTarget?.url;
  const token = args.token ?? selectedTarget?.token;
  const timeoutMs = selectedTarget?.timeoutMs;

  if (!url) {
    throw new AsyncCliError("missing async target url. set --url or config.async.client.targets");
  }

  if (!token) {
    throw new AsyncCliError(
      "missing async target token. set --token or config.async.client.targets",
    );
  }

  return { url, token, timeoutMs };
}

function buildUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path.startsWith("/") ? path.slice(1) : path, base).toString();
}

const ErrorEnvelopeSchema = z
  .object({
    error: z.unknown(),
  })
  .transform((payload) => String(payload.error));

const SuccessEnvelopeSchema = z.object({
  ok: z.literal(true),
  data: z.unknown(),
});

function throwRequestFailure(status: number, payload: unknown): never {
  const parsedError = ErrorEnvelopeSchema.safeParse(payload);
  if (parsedError.success) {
    throw new AsyncCliError(`request failed (${status}): ${parsedError.data}`);
  }

  throw new AsyncCliError(`request failed (${status})`);
}

function parseResponsePayload(text: string): unknown {
  if (!text.trim()) {
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function requestJson(args: {
  target: ResolvedTarget;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  fetchImpl: typeof fetch;
}): Promise<z.infer<typeof SuccessEnvelopeSchema>> {
  const controller = new AbortController();
  const timeoutMs = args.target.timeoutMs ?? 30_000;

  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  timeout.unref?.();

  try {
    const response = await args.fetchImpl(buildUrl(args.target.url, args.path), {
      method: args.method,
      headers: {
        authorization: `Bearer ${args.target.token}`,
        accept: "application/json",
        ...(args.body === undefined
          ? {}
          : {
              "content-type": "application/json",
            }),
      },
      ...(args.body === undefined ? {} : { body: JSON.stringify(args.body) }),
      signal: controller.signal,
    });

    const payload = parseResponsePayload(await response.text());

    if (!response.ok) {
      throwRequestFailure(response.status, payload);
    }

    const successPayload = SuccessEnvelopeSchema.safeParse(payload);
    if (!successPayload.success) {
      throw new AsyncCliError(`unexpected response format (${response.status})`);
    }

    return successPayload.data;
  } catch (error) {
    if (error instanceof AsyncCliError) {
      throw error;
    }

    if ((error as { name?: string }).name === "AbortError") {
      throw new AsyncCliError(`request timed out after ${timeoutMs}ms`);
    }

    throw new AsyncCliError(
      `request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function toJsonLine(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function printAsyncHelp(log: (line: string) => void = console.log): void {
  log(
    [
      "usage:",
      "  tau async daemon --config-file <path>",
      "  tau async --project <id> <prompt...>",
      "  tau async <prompt...>",
      "  tau async list",
      "  tau async status <id>",
      "  tau async logs <id>",
      "  tau async send <id> <text...>",
      "  tau async interrupt <id>",
      "  tau async cron list",
      "  tau async cron runs [jobId]",
      "  tau async cron run <jobId>",
      "",
      "options:",
      "  --project <id>        project id for session creation (overrides config).",
      "  --config-file <path>  daemon config file path (daemon mode only).",
      "  --target <id>         target id from config.async.client.targets.",
      "  --url <url>           override async target base URL.",
      "  --token <token>       override async bearer token.",
      "  --                    treat remaining args as prompt text.",
      "  --help                show this help and exit.",
    ].join("\n"),
  );
}

async function runDaemon(args: {
  configFilePath: string;
  env: NodeJS.ProcessEnv;
  config: Config;
  stdout: (line: string) => void;
}): Promise<void> {
  let daemonConfig: ReturnType<typeof loadAsyncDaemonConfig>;
  try {
    daemonConfig = loadAsyncDaemonConfig(args.configFilePath);
  } catch (error) {
    if (error instanceof AsyncDaemonConfigError) {
      throw new AsyncCliError(error.message);
    }

    throw error;
  }

  const authToken = getTrimmedEnvValue("TAU_ASYNC_AUTH_TOKEN", args.env) ?? daemonConfig.authToken;
  const speechToTextProvider = args.config.speechToText?.provider ?? "mistral";
  const geminiApiKey = getGoogleApiKey(args.config, args.env);
  const mistralApiKey = getMistralApiKey(args.config, args.env);

  if (!authToken) {
    throw new AsyncCliError(
      "missing async auth token. set authToken in daemon config or TAU_ASYNC_AUTH_TOKEN",
    );
  }

  const sessionManager = createAsyncSessionManager({
    projects: daemonConfig.projects,
    workspaceRoot: daemonConfig.workspaceRoot,
    maxSessions: daemonConfig.maxSessions,
    systemMessage: daemonConfig.systemMessage,
  });

  const startupCleanupResults = await cleanupWorkspaceRootsOnStartup(
    collectDaemonWorkspaceRoots(daemonConfig),
  );
  logStartupCleanupSummary({
    stdout: args.stdout,
    results: startupCleanupResults,
  });

  let runtime: Awaited<ReturnType<typeof startAsyncDaemonRuntime>>;

  try {
    runtime = await startAsyncDaemonRuntime({
      daemonConfig,
      authToken,
      speechToTextProvider,
      geminiApiKey,
      mistralApiKey,
      sessionManager,
      onLog: args.stdout,
    });
  } catch (error) {
    if (error instanceof AsyncDaemonRuntimeError) {
      throw new AsyncCliError(error.message);
    }

    throw error;
  }

  args.stdout(`tau async daemon listening on ${runtime.baseUrl}`);

  await new Promise<void>((resolvePromise) => {
    let shuttingDown = false;

    const onSignal = () => {
      if (shuttingDown) {
        return;
      }

      shuttingDown = true;
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);

      void runtime.close().then(() => {
        resolvePromise();
      });
    };

    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}

export async function runAsyncCommand(
  argv: string[],
  options: RunAsyncCommandOptions = {},
): Promise<void> {
  const parsed = parseAsyncArgs(argv);
  const stdout = options.stdout ?? console.log;

  if (parsed.help) {
    printAsyncHelp(stdout);
    return;
  }

  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const config = options.config ?? loadConfig(cwd, createDefaultConfigDeps());

  if (parsed.command === "daemon") {
    if (!parsed.configFilePath) {
      throw new AsyncCliError("missing --config-file <path> for daemon mode");
    }

    await runDaemon({ configFilePath: parsed.configFilePath, env, config, stdout });
    return;
  }

  if (parsed.configFilePath) {
    throw new AsyncCliError("--config-file can only be used with 'tau async daemon'");
  }

  const target = resolveTarget(config, parsed);
  const fetchImpl = options.fetchImpl ?? fetch;

  const request = (() => {
    switch (parsed.command) {
      case "create":
        return {
          method: "POST" as const,
          path: "/v1/sessions",
          body: {
            projectId: resolveProjectId(parsed, config),
            prompt: parsed.prompt,
          },
        };
      case "list":
        return { method: "GET" as const, path: "/v1/sessions" };
      case "status":
        return {
          method: "GET" as const,
          path: `/v1/sessions/${encodeURIComponent(parsed.sessionId)}`,
        };
      case "logs":
        return {
          method: "GET" as const,
          path: `/v1/sessions/${encodeURIComponent(parsed.sessionId)}/logs`,
        };
      case "send":
        return {
          method: "POST" as const,
          path: `/v1/sessions/${encodeURIComponent(parsed.sessionId)}/messages`,
          body: { text: parsed.text },
        };
      case "interrupt":
        return {
          method: "POST" as const,
          path: `/v1/sessions/${encodeURIComponent(parsed.sessionId)}/interrupt`,
          body: {},
        };
      case "cron-list":
        return { method: "GET" as const, path: "/v1/cron/jobs" };
      case "cron-runs": {
        const query = parsed.cronJobId ? `?jobId=${encodeURIComponent(parsed.cronJobId)}` : "";
        return { method: "GET" as const, path: `/v1/cron/runs${query}` };
      }
      case "cron-run":
        return {
          method: "POST" as const,
          path: `/v1/cron/jobs/${encodeURIComponent(parsed.cronJobId)}/run`,
          body: {},
        };
    }
  })();

  const payload = await requestJson({
    target,
    method: request.method,
    path: request.path,
    ...(request.body === undefined ? {} : { body: request.body }),
    fetchImpl,
  });
  stdout(toJsonLine(payload));
}
