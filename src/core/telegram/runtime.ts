import type { SpeechToTextProvider } from "../config/schema.js";
import { startTelegramAdapter, type TelegramAdapterHandle } from "./adapter.js";
import type { TelegramConfig } from "./config.js";
import {
  createTelegramProjectPreferenceStore,
  resolveTelegramProjectPreferencesPath,
} from "./project_preferences.js";
import {
  createTelegramSessionManager,
  resolveTelegramSessionStatePath,
  type TelegramSessionClient,
  type TelegramSessionClientOptions,
  type TelegramSessionManager,
} from "./session_manager.js";

export type TelegramRuntimeDependencies = {
  startTelegramAdapter: typeof startTelegramAdapter;
};

export type StartTelegramRuntimeOptions = {
  config: TelegramConfig;
  speechToTextProvider?: SpeechToTextProvider;
  geminiApiKey?: string;
  mistralApiKey?: string;
  createSessionClient: (options: TelegramSessionClientOptions) => Promise<TelegramSessionClient>;
  onLog?: (line: string) => void;
  deps?: Partial<TelegramRuntimeDependencies>;
};

export type TelegramRuntimeHandle = {
  close(): Promise<void>;
};

export class TelegramRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramRuntimeError";
  }
}

type RuntimeResources = {
  telegramAdapters: TelegramAdapterHandle[];
  sessionManager: TelegramSessionManager;
};

type RuntimeLogEntry = {
  level: string;
  message: string;
  data?: unknown;
};

const defaultDeps: TelegramRuntimeDependencies = {
  startTelegramAdapter: startTelegramAdapter,
};

function formatRuntimeLog(scope: string, entry: RuntimeLogEntry): string {
  const cause =
    typeof entry.data === "object" &&
    entry.data !== null &&
    "cause" in entry.data &&
    typeof entry.data.cause === "string"
      ? entry.data.cause.trim()
      : "";
  return `[${scope}:${entry.level}] ${entry.message}${cause ? `: ${cause}` : ""}`;
}

async function closeRuntimeResources(resources: Partial<RuntimeResources>): Promise<void> {
  await Promise.allSettled([
    ...(resources.telegramAdapters ?? []).map((adapter) => adapter.close()),
    ...(resources.sessionManager ? [resources.sessionManager.close()] : []),
  ]);
}

class TelegramRuntime implements TelegramRuntimeHandle {
  private readonly resources: RuntimeResources;
  private closePromise?: Promise<void>;

  constructor(resources: RuntimeResources) {
    this.resources = resources;
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      await this.closePromise;
      return;
    }

    this.closePromise = closeRuntimeResources(this.resources);
    await this.closePromise;
  }
}

export async function startTelegramRuntime(
  options: StartTelegramRuntimeOptions,
): Promise<TelegramRuntimeHandle> {
  const deps = {
    ...defaultDeps,
    ...options.deps,
  };

  const sessionManager = createTelegramSessionManager({
    projects: options.config.projects,
    workspaceRoot: options.config.workspaceRoot,
    maxSessions: options.config.maxSessions,
    systemMessage: options.config.systemMessage,
    persistencePath: resolveTelegramSessionStatePath(options.config.workspaceRoot),
    onLog: (entry) => {
      options.onLog?.(formatRuntimeLog("telegram", entry));
    },
    createClient: options.createSessionClient,
  });

  const projectPreferences = createTelegramProjectPreferenceStore(
    resolveTelegramProjectPreferencesPath(options.config.workspaceRoot),
  );
  const telegramAdapters: TelegramAdapterHandle[] = [];

  try {
    await Promise.all([sessionManager.initialize(), projectPreferences.initialize()]);

    for (const [botId, botConfig] of Object.entries(options.config.bots)) {
      if (!botConfig.botToken) {
        throw new TelegramRuntimeError(`telegram bot '${botId}' is missing required botToken`);
      }

      const allowedProjectIds = botConfig.allowedProjectIds ?? Object.keys(options.config.projects);
      const scopedProjects: typeof options.config.projects = {};

      for (const projectId of allowedProjectIds) {
        const project = options.config.projects[projectId];
        if (project) {
          scopedProjects[projectId] = project;
        }
      }

      const telegramAdapter = await deps.startTelegramAdapter({
        botId,
        botToken: botConfig.botToken,
        projects: scopedProjects,
        defaultProjectId: botConfig.defaultProjectId,
        systemMessage: botConfig.systemMessage,
        allowedUserIds: botConfig.allowedUserIds,
        allowedChatIds: botConfig.allowedChatIds,
        pollIntervalMs: botConfig.pollIntervalMs,
        requestTimeoutSeconds: botConfig.requestTimeoutSeconds,
        speechToTextProvider: options.speechToTextProvider,
        geminiApiKey: options.geminiApiKey,
        mistralApiKey: options.mistralApiKey,
        sessionManager,
        projectPreferences,
        onLog: (entry) => {
          options.onLog?.(formatRuntimeLog(`telegram:${botId}`, entry));
        },
      });

      telegramAdapters.push(telegramAdapter);
      options.onLog?.(`tau telegram adapter enabled (${botId})`);
    }
  } catch (error) {
    await closeRuntimeResources({
      telegramAdapters,
      sessionManager,
    });

    if (error instanceof TelegramRuntimeError) {
      throw error;
    }

    throw new TelegramRuntimeError(
      `failed to start telegram runtime: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return new TelegramRuntime({
    telegramAdapters,
    sessionManager,
  });
}
