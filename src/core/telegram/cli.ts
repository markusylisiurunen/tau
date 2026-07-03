import { createDefaultConfigDeps } from "../config/deps.js";
import type { Config } from "../config/schema.js";
import { getGoogleApiKey, getMistralApiKey, loadConfig } from "../config/schema.js";
import { loadTelegramConfig, TelegramConfigError } from "./config.js";
import { startTelegramRuntime, TelegramRuntimeError } from "./runtime.js";
import type { TelegramSessionClient, TelegramSessionClientOptions } from "./session_manager.js";
import { cleanupWorkspaceRootsOnStartup } from "./workspace.js";

export class TelegramCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramCliError";
  }
}

type ParsedTelegramArgs = {
  help: boolean;
  configFilePath?: string;
};

export type RunTelegramCommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  config?: Config;
  createSessionClient?: (options: TelegramSessionClientOptions) => Promise<TelegramSessionClient>;
  stdout?: (line: string) => void;
};

function requireTrimmedValue(value: string | undefined, message: string): string {
  if (typeof value !== "string") {
    throw new TelegramCliError(message);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new TelegramCliError(message);
  }

  return trimmed;
}

function parseTelegramArgs(argv: string[]): ParsedTelegramArgs {
  let help = false;
  let configFilePath: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg === "--config-file") {
      configFilePath = requireTrimmedValue(argv[i + 1], "missing value for --config-file");
      i += 1;
      continue;
    }

    if (arg.startsWith("--config-file=")) {
      configFilePath = requireTrimmedValue(
        arg.slice("--config-file=".length),
        "missing value for --config-file",
      );
      continue;
    }

    throw new TelegramCliError(`unknown option: ${arg}`);
  }

  return {
    help,
    ...(configFilePath === undefined ? {} : { configFilePath }),
  };
}

function logStartupCleanupSummary(args: {
  stdout: (line: string) => void;
  results: Awaited<ReturnType<typeof cleanupWorkspaceRootsOnStartup>>;
}): void {
  for (const result of args.results) {
    if (result.deletedEntries > 0) {
      args.stdout(
        `[telegram:info] startup workspace cleanup removed ${result.deletedEntries} entries under ${result.workspaceRoot}`,
      );
    }

    for (const failure of result.failures) {
      args.stdout(
        `[telegram:warn] startup workspace cleanup failed for ${failure.path}: ${failure.cause}`,
      );
    }
  }
}

function collectWorkspaceRoots(config: ReturnType<typeof loadTelegramConfig>): string[] {
  const roots = new Set<string>([config.workspaceRoot]);

  for (const project of Object.values(config.projects)) {
    if (project.workspaceRoot) {
      roots.add(project.workspaceRoot);
    }
  }

  return Array.from(roots);
}

export function printTelegramHelp(log: (line: string) => void = console.log): void {
  log(
    [
      "usage:",
      "  tau telegram --config-file <path>",
      "",
      "options:",
      "  --config-file <path>  telegram runner config file path.",
      "  --help                show this help and exit.",
    ].join("\n"),
  );
}

export async function runTelegramCommand(
  argv: string[],
  options: RunTelegramCommandOptions = {},
): Promise<void> {
  const parsed = parseTelegramArgs(argv);
  const stdout = options.stdout ?? console.log;

  if (parsed.help) {
    printTelegramHelp(stdout);
    return;
  }

  if (!parsed.configFilePath) {
    throw new TelegramCliError("missing --config-file <path>");
  }

  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const config = options.config ?? loadConfig(cwd, createDefaultConfigDeps());
  const speechToTextProvider = config.speechToText?.provider ?? "mistral";
  const geminiApiKey = getGoogleApiKey(config, env);
  const mistralApiKey = getMistralApiKey(config, env);

  const createSessionClient = options.createSessionClient;
  if (!createSessionClient) {
    throw new TelegramCliError("missing telegram session client factory");
  }

  const telegramConfig = (() => {
    try {
      return loadTelegramConfig(parsed.configFilePath);
    } catch (error) {
      if (error instanceof TelegramConfigError) {
        throw new TelegramCliError(error.message);
      }
      throw error;
    }
  })();

  const startupCleanupResults = await cleanupWorkspaceRootsOnStartup(
    collectWorkspaceRoots(telegramConfig),
  );
  logStartupCleanupSummary({
    stdout,
    results: startupCleanupResults,
  });

  const runtime = await (async () => {
    try {
      return await startTelegramRuntime({
        config: telegramConfig,
        speechToTextProvider,
        geminiApiKey,
        mistralApiKey,
        createSessionClient,
        onLog: stdout,
      });
    } catch (error) {
      if (error instanceof TelegramRuntimeError) {
        throw new TelegramCliError(error.message);
      }
      throw error;
    }
  })();

  stdout("tau telegram running");

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
