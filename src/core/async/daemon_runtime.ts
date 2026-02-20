import { type AsyncCronScheduler, startAsyncCronScheduler } from "./cron.js";
import { type AsyncHttpServerHandle, startAsyncHttpServer } from "./http_server.js";
import type { AsyncDaemonConfig } from "./server_config.js";
import type { AsyncSessionManager } from "./session_manager.js";
import { type AsyncTelegramAdapterHandle, startAsyncTelegramAdapter } from "./telegram.js";

type AsyncDaemonRuntimeDependencies = {
  startCronScheduler: typeof startAsyncCronScheduler;
  startHttpServer: typeof startAsyncHttpServer;
  startTelegramAdapter: typeof startAsyncTelegramAdapter;
};

export type StartAsyncDaemonRuntimeOptions = {
  daemonConfig: AsyncDaemonConfig;
  authToken: string;
  mistralApiKey?: string;
  sessionManager: AsyncSessionManager;
  onLog?: (line: string) => void;
  deps?: Partial<AsyncDaemonRuntimeDependencies>;
};

export type AsyncDaemonRuntimeHandle = {
  baseUrl: string;
  close(): Promise<void>;
};

export class AsyncDaemonRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AsyncDaemonRuntimeError";
  }
}

type RuntimeResources = {
  httpServer: AsyncHttpServerHandle;
  telegramAdapters: AsyncTelegramAdapterHandle[];
  cronScheduler?: AsyncCronScheduler;
  sessionManager: AsyncSessionManager;
};

const defaultDeps: AsyncDaemonRuntimeDependencies = {
  startCronScheduler: startAsyncCronScheduler,
  startHttpServer: startAsyncHttpServer,
  startTelegramAdapter: startAsyncTelegramAdapter,
};

async function closeRuntimeResources(resources: Partial<RuntimeResources>): Promise<void> {
  await Promise.allSettled([
    ...(resources.httpServer ? [resources.httpServer.close()] : []),
    ...(resources.telegramAdapters ?? []).map((adapter) => adapter.close()),
    ...(resources.cronScheduler ? [resources.cronScheduler.close()] : []),
    ...(resources.sessionManager ? [resources.sessionManager.close()] : []),
  ]);
}

class AsyncDaemonRuntime implements AsyncDaemonRuntimeHandle {
  readonly baseUrl: string;
  private readonly resources: RuntimeResources;
  private closePromise?: Promise<void>;

  constructor(resources: RuntimeResources) {
    this.resources = resources;
    this.baseUrl = resources.httpServer.baseUrl;
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

export async function startAsyncDaemonRuntime(
  options: StartAsyncDaemonRuntimeOptions,
): Promise<AsyncDaemonRuntimeHandle> {
  const deps = {
    ...defaultDeps,
    ...options.deps,
  };

  const telegramConfigs = options.daemonConfig.telegram
    ? Object.entries(options.daemonConfig.telegram)
    : [];

  let cronScheduler: AsyncCronScheduler | undefined;
  let httpServer: AsyncHttpServerHandle | undefined;
  const telegramAdapters: AsyncTelegramAdapterHandle[] = [];

  try {
    if (options.daemonConfig.cronJobs !== undefined) {
      cronScheduler = deps.startCronScheduler({
        jobs: options.daemonConfig.cronJobs,
        sessionManager: options.sessionManager,
        additionalSystemMessage: options.daemonConfig.cron?.systemMessage,
        onLog: (entry) => {
          options.onLog?.(`[cron:${entry.level}] ${entry.message}`);
        },
      });

      options.onLog?.("tau async cron scheduler enabled");
    }

    httpServer = await deps.startHttpServer({
      host: options.daemonConfig.host,
      port: options.daemonConfig.port,
      authToken: options.authToken,
      sessionManager: options.sessionManager,
      ...(cronScheduler ? { cronScheduler } : {}),
    });

    for (const [botId, telegramConfig] of telegramConfigs) {
      if (!telegramConfig.botToken) {
        throw new AsyncDaemonRuntimeError(`telegram bot '${botId}' is missing required botToken`);
      }

      const allowedProjectIds =
        telegramConfig.allowedProjectIds ?? Object.keys(options.daemonConfig.projects);
      const scopedProjects: typeof options.daemonConfig.projects = {};

      for (const projectId of allowedProjectIds) {
        const project = options.daemonConfig.projects[projectId];
        if (project) {
          scopedProjects[projectId] = project;
        }
      }

      const telegramAdapter = await deps.startTelegramAdapter({
        botId,
        botToken: telegramConfig.botToken,
        projects: scopedProjects,
        defaultProjectId: telegramConfig.defaultProjectId,
        systemMessage: telegramConfig.systemMessage,
        allowedUserIds: telegramConfig.allowedUserIds,
        allowedChatIds: telegramConfig.allowedChatIds,
        pollIntervalMs: telegramConfig.pollIntervalMs,
        requestTimeoutSeconds: telegramConfig.requestTimeoutSeconds,
        mistralApiKey: options.mistralApiKey,
        sessionManager: options.sessionManager,
        onLog: (entry) => {
          options.onLog?.(`[telegram:${botId}:${entry.level}] ${entry.message}`);
        },
      });

      telegramAdapters.push(telegramAdapter);
      options.onLog?.(`tau async telegram adapter enabled (${botId})`);
    }
  } catch (error) {
    await closeRuntimeResources({
      httpServer,
      telegramAdapters,
      cronScheduler,
      sessionManager: options.sessionManager,
    });

    throw new AsyncDaemonRuntimeError(
      `failed to start async adapters: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return new AsyncDaemonRuntime({
    httpServer,
    telegramAdapters,
    cronScheduler,
    sessionManager: options.sessionManager,
  });
}
