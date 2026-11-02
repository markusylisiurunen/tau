import { homedir } from "node:os";
import type { HostConfig } from "../core/config/ownership.js";
import { resolveHistoryRemoteTarget } from "../core/history/config.js";
import { HistoryManager } from "../core/history/history_manager.js";
import { getDefaultHistoryDatabasePath } from "../core/history/local_history_store.js";
import {
  getDefaultModelCatalogStorePath,
  RemoteModelCatalog,
} from "../core/models/remote_catalog.js";
import { createDefaultCoreDeps } from "../core/runtime/deps.js";
import type { AutoCompactDefaults } from "../core/session/auto_compaction_threshold.js";
import { createLocalToolExecutionBackend } from "../core/tools/execution_backend.js";
import { CompositeExecutionEnvironmentResolver } from "../execution/execution_environment.js";
import { LocalExecutionEnvironmentResolver } from "../execution/local_execution_environment.js";
import { LocalSessionHost } from "../host/local_session_host.js";
import { resolveSessionBootstrap } from "../host/session_bootstrap.js";
import type { SessionProtocolPersonaOverrides } from "../protocol/session_protocol.js";
import { FileSessionStore, getDefaultSessionStoreDirectory } from "../store/file_session_store.js";
import { InProcessSessionProtocolTransport } from "../transport/in_process_session_transport.js";
import { createTauSdkClientFromTransport, resolveTauSdkInitializeParams } from "./session.js";
import type { TauSdkClient, TauSdkClientOptions } from "./types.js";

export async function createTauSdkClientWithHostConfig(
  options: TauSdkClientOptions,
  config: HostConfig,
  runtimeOptions: {
    remoteModelCatalog?: RemoteModelCatalog;
    autoCompactDefaults?: AutoCompactDefaults;
    initialPersonaSelection?: { personaId: string | null } & SessionProtocolPersonaOverrides;
  } = {},
): Promise<TauSdkClient> {
  resolveTauSdkInitializeParams(options.initialize, options.clientTools);
  const host = await createInProcessSdkHost(options, config, runtimeOptions);
  const transport = new InProcessSessionProtocolTransport({
    host,
    closeMode: "shutdown-host",
  });
  return await createTauSdkClientFromTransport(transport, options);
}

async function createInProcessSdkHost(
  options: TauSdkClientOptions,
  config: HostConfig,
  runtimeOptions: {
    remoteModelCatalog?: RemoteModelCatalog;
    autoCompactDefaults?: AutoCompactDefaults;
    initialPersonaSelection?: { personaId: string | null } & SessionProtocolPersonaOverrides;
  },
): Promise<LocalSessionHost> {
  const deps = createDefaultCoreDeps();
  const home = deps.env.home() || process.env.HOME || homedir();
  const ownsRemoteModelCatalog = runtimeOptions.remoteModelCatalog === undefined;
  const remoteModelCatalog =
    runtimeOptions.remoteModelCatalog ??
    new RemoteModelCatalog({ path: getDefaultModelCatalogStorePath(home) });

  const toolBackend = createLocalToolExecutionBackend();
  const localResolver = new LocalExecutionEnvironmentResolver({
    home,
    toolBackend,
  });
  const resolvers: ConstructorParameters<typeof CompositeExecutionEnvironmentResolver>[0] = {
    local: localResolver,
  };
  if (config.flySprites) {
    const { FlySpriteExecutionEnvironmentResolver } = await import(
      "../execution/fly_sprite_execution_environment.js"
    );
    resolvers["fly-sprite"] = new FlySpriteExecutionEnvironmentResolver({
      connection: config.flySprites,
    });
  }
  const executionEnvironmentResolver = new CompositeExecutionEnvironmentResolver(resolvers);

  let onShutdown: (() => Promise<void>) | undefined;
  if (
    ownsRemoteModelCatalog &&
    options.refreshModelCatalog !== false &&
    process.env.TAU_OFFLINE === undefined
  ) {
    const controller = new AbortController();
    const refresh = remoteModelCatalog.refresh({ signal: controller.signal });
    void refresh.catch(() => {});
    onShutdown = async () => {
      controller.abort();
      await refresh.catch(() => {});
    };
  }

  const host = new LocalSessionHost({
    autoCompactDefaults: runtimeOptions.autoCompactDefaults,
    store: new FileSessionStore({ directory: getDefaultSessionStoreDirectory(home) }),
    history: HistoryManager.open(getDefaultHistoryDatabasePath(home), {
      reportReplicationFailure: options.onDiagnostic,
      reportRecording: options.onDiagnostic,
    }),
    historyRemote: resolveHistoryRemoteTarget(config),
    ...(onShutdown ? { onShutdown } : {}),
    executionEnvironmentResolver,
    includeAgentContext: !options.noAgentContextFiles,
    getRemoteModelCatalog: () => remoteModelCatalog.snapshot(),
    environment: {
      now: () => deps.clock.now(),
    },
    deps,
    resolveSessionBootstrap: async ({ executionEnvironment, remoteCatalog, recovering }) =>
      await resolveSessionBootstrap({
        executionEnvironment,
        remoteCatalog,
        recovering,
        hostApiKeys: config.apiKeys,
        personaRequest: runtimeOptions.initialPersonaSelection
          ? { selection: runtimeOptions.initialPersonaSelection }
          : { persona: options.persona, reasoning: options.reasoning },
        onDiagnostic: options.onDiagnostic,
      }),
  });
  return host;
}
