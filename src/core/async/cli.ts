import type { Config } from "../config/schema.js";
import { loadConfig } from "../config/schema.js";
import { startAsyncHttpServer } from "./http_server.js";
import { AsyncDaemonConfigError, loadAsyncDaemonConfig } from "./server_config.js";
import { createAsyncSessionManager } from "./session_manager.js";
import { startAsyncTelegramAdapter } from "./telegram.js";

export class AsyncCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AsyncCliError";
  }
}

type AsyncCommand = "create" | "daemon" | "list" | "status" | "logs" | "send" | "cancel";

type ParsedAsyncArgs = {
  help: boolean;
  command: AsyncCommand;
  prompt?: string;
  sessionId?: string;
  text?: string;
  projectId?: string;
  targetId?: string;
  url?: string;
  token?: string;
  configFilePath?: string;
};

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

function parseValue(
  arg: string,
  argv: string[],
  index: number,
): { value: string; nextIndex: number } {
  const eqIndex = arg.indexOf("=");
  if (eqIndex !== -1) {
    const value = arg.slice(eqIndex + 1).trim();
    if (!value) {
      throw new AsyncCliError(`missing value for ${arg.slice(0, eqIndex)}`);
    }
    return { value, nextIndex: index };
  }

  const next = argv[index + 1];
  if (!next || next.startsWith("-")) {
    throw new AsyncCliError(`missing value for ${arg}`);
  }

  const value = next.trim();
  if (!value) {
    throw new AsyncCliError(`missing value for ${arg}`);
  }

  return { value, nextIndex: index + 1 };
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

    if (arg === "--project" || arg.startsWith("--project=")) {
      const parsed = parseValue(arg, argv, i);
      i = parsed.nextIndex;
      projectId = parsed.value;
      continue;
    }

    if (arg === "--target" || arg.startsWith("--target=")) {
      const parsed = parseValue(arg, argv, i);
      i = parsed.nextIndex;
      targetId = parsed.value;
      continue;
    }

    if (arg === "--url" || arg.startsWith("--url=")) {
      const parsed = parseValue(arg, argv, i);
      i = parsed.nextIndex;
      url = parsed.value;
      continue;
    }

    if (arg === "--token" || arg.startsWith("--token=")) {
      const parsed = parseValue(arg, argv, i);
      i = parsed.nextIndex;
      token = parsed.value;
      continue;
    }

    if (arg === "--config-file" || arg.startsWith("--config-file=")) {
      const parsed = parseValue(arg, argv, i);
      i = parsed.nextIndex;
      configFilePath = parsed.value;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new AsyncCliError(`unknown option: ${arg}`);
    }

    positional.push(arg);
  }

  const toCreateArgs = (): ParsedAsyncArgs => {
    const prompt = positional.join(" ").trim();
    if (!prompt) {
      throw new AsyncCliError("missing prompt text");
    }

    return {
      help,
      command: "create",
      prompt,
      projectId,
      targetId,
      url,
      token,
      configFilePath,
    };
  };

  const first = positional[0];
  if (!first) {
    if (help) {
      return { help: true, command: "list", projectId, targetId, url, token, configFilePath };
    }
    throw new AsyncCliError("missing async command or prompt");
  }

  if (forcePrompt) {
    return toCreateArgs();
  }

  if (first === "daemon") {
    if (positional.length === 1) {
      return { help, command: "daemon", projectId, targetId, url, token, configFilePath };
    }
    return toCreateArgs();
  }

  if (first === "list") {
    if (positional.length === 1) {
      return { help, command: "list", projectId, targetId, url, token, configFilePath };
    }
    return toCreateArgs();
  }

  if (first === "status") {
    if (positional.length === 1) {
      throw new AsyncCliError("missing session id for status");
    }
    if (positional.length === 2) {
      const sessionId = positional[1]?.trim();
      if (!sessionId) {
        throw new AsyncCliError("missing session id for status");
      }
      return {
        help,
        command: "status",
        sessionId,
        projectId,
        targetId,
        url,
        token,
        configFilePath,
      };
    }
    return toCreateArgs();
  }

  if (first === "logs") {
    if (positional.length === 1) {
      throw new AsyncCliError("missing session id for logs");
    }
    if (positional.length === 2) {
      const sessionId = positional[1]?.trim();
      if (!sessionId) {
        throw new AsyncCliError("missing session id for logs");
      }
      return {
        help,
        command: "logs",
        sessionId,
        projectId,
        targetId,
        url,
        token,
        configFilePath,
      };
    }
    return toCreateArgs();
  }

  if (first === "send") {
    if (positional.length === 1) {
      throw new AsyncCliError("missing session id for send");
    }

    const sessionId = positional[1]?.trim();
    if (!sessionId) {
      throw new AsyncCliError("missing session id for send");
    }

    if (positional.length === 2) {
      throw new AsyncCliError("missing message text for send");
    }

    const text = positional.slice(2).join(" ").trim();
    if (!text) {
      throw new AsyncCliError("missing message text for send");
    }

    return {
      help,
      command: "send",
      sessionId,
      text,
      projectId,
      targetId,
      url,
      token,
      configFilePath,
    };
  }

  if (first === "cancel") {
    if (positional.length === 1) {
      throw new AsyncCliError("missing session id for cancel");
    }
    if (positional.length === 2) {
      const sessionId = positional[1]?.trim();
      if (!sessionId) {
        throw new AsyncCliError("missing session id for cancel");
      }
      return {
        help,
        command: "cancel",
        sessionId,
        projectId,
        targetId,
        url,
        token,
        configFilePath,
      };
    }
    return toCreateArgs();
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

function resolveProjectId(args: ParsedAsyncArgs, config: Config): string {
  const configured = config.async?.client?.defaultProjectId;
  const projectId = args.projectId?.trim() || configured?.trim();
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

async function requestJson(args: {
  target: ResolvedTarget;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  fetchImpl: typeof fetch;
}): Promise<unknown> {
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

    const text = await response.text();
    let payload: unknown;

    if (text.trim()) {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        payload = text;
      }
    }

    if (!response.ok) {
      if (payload && typeof payload === "object" && payload !== null && "error" in payload) {
        throw new AsyncCliError(`request failed (${response.status}): ${String(payload.error)}`);
      }
      throw new AsyncCliError(`request failed (${response.status})`);
    }

    return payload;
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
      "  tau async cancel <id>",
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

  const handle = await startAsyncHttpServer({
    host: daemonConfig.host,
    port: daemonConfig.port,
    authToken,
    sessionManager,
  });

  const telegramConfig = daemonConfig.telegram;
  let telegramHandle: { close(): Promise<void> } | undefined;

  try {
    if (telegramConfig?.botToken) {
      telegramHandle = await startAsyncTelegramAdapter({
        botToken: telegramConfig.botToken,
        projects: daemonConfig.projects,
        defaultProjectId: telegramConfig.defaultProjectId,
        systemMessage: telegramConfig.systemMessage,
        allowedUserIds: telegramConfig.allowedUserIds,
        allowedChatIds: telegramConfig.allowedChatIds,
        pollIntervalMs: telegramConfig.pollIntervalMs,
        requestTimeoutSeconds: telegramConfig.requestTimeoutSeconds,
        sessionManager,
        onLog: (entry) => {
          args.stdout(`[telegram:${entry.level}] ${entry.message}`);
        },
      });

      args.stdout("tau async telegram adapter enabled");
    }
  } catch (error) {
    await Promise.allSettled([handle.close(), sessionManager.close()]);
    throw new AsyncCliError(
      `failed to start telegram adapter: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  args.stdout(`tau async daemon listening on ${handle.baseUrl}`);

  await new Promise<void>((resolvePromise) => {
    let shuttingDown = false;

    const onSignal = () => {
      if (shuttingDown) {
        return;
      }

      shuttingDown = true;
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);

      void Promise.allSettled([
        handle.close(),
        ...(telegramHandle ? [telegramHandle.close()] : []),
        sessionManager.close(),
      ]).then(() => {
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
  const config = options.config ?? loadConfig(cwd);

  if (parsed.command === "daemon") {
    if (!parsed.configFilePath) {
      throw new AsyncCliError("missing --config-file <path> for daemon mode");
    }

    await runDaemon({ configFilePath: parsed.configFilePath, env, stdout });
    return;
  }

  if (parsed.configFilePath) {
    throw new AsyncCliError("--config-file can only be used with 'tau async daemon'");
  }

  const target = resolveTarget(config, parsed);
  const fetchImpl = options.fetchImpl ?? fetch;

  if (parsed.command === "create") {
    const projectId = resolveProjectId(parsed, config);
    const payload = await requestJson({
      target,
      method: "POST",
      path: "/v1/sessions",
      body: {
        projectId,
        prompt: parsed.prompt,
      },
      fetchImpl,
    });

    stdout(toJsonLine(payload));
    return;
  }

  if (parsed.command === "list") {
    const payload = await requestJson({
      target,
      method: "GET",
      path: "/v1/sessions",
      fetchImpl,
    });
    stdout(toJsonLine(payload));
    return;
  }

  if (parsed.command === "status") {
    const payload = await requestJson({
      target,
      method: "GET",
      path: `/v1/sessions/${encodeURIComponent(parsed.sessionId ?? "")}`,
      fetchImpl,
    });
    stdout(toJsonLine(payload));
    return;
  }

  if (parsed.command === "logs") {
    const payload = await requestJson({
      target,
      method: "GET",
      path: `/v1/sessions/${encodeURIComponent(parsed.sessionId ?? "")}/logs`,
      fetchImpl,
    });
    stdout(toJsonLine(payload));
    return;
  }

  if (parsed.command === "send") {
    const payload = await requestJson({
      target,
      method: "POST",
      path: `/v1/sessions/${encodeURIComponent(parsed.sessionId ?? "")}/messages`,
      body: {
        text: parsed.text,
      },
      fetchImpl,
    });
    stdout(toJsonLine(payload));
    return;
  }

  if (parsed.command === "cancel") {
    const payload = await requestJson({
      target,
      method: "POST",
      path: `/v1/sessions/${encodeURIComponent(parsed.sessionId ?? "")}/cancel`,
      body: {},
      fetchImpl,
    });
    stdout(toJsonLine(payload));
    return;
  }

  throw new AsyncCliError("unsupported async command");
}
