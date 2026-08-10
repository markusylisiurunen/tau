import { createTauSdkClientWithHostConfig } from "../../sdk/local_client.js";
import { createCommandClientTools } from "../client_tools/command_client_tools.js";
import type { ConfigDeps } from "../config/deps.js";
import { type Config, loadConfig } from "../config/schema.js";
import type { TelegramSessionClient, TelegramSessionClientOptions } from "./session_manager.js";

type LocalTelegramSessionClientDependencies = {
  loadConfig: typeof loadConfig;
  createCommandClientTools: typeof createCommandClientTools;
  createSdkClient: typeof createTauSdkClientWithHostConfig;
};

const defaultDependencies: LocalTelegramSessionClientDependencies = {
  loadConfig,
  createCommandClientTools,
  createSdkClient: createTauSdkClientWithHostConfig,
};

export async function createLocalTelegramSessionClient(options: {
  client: TelegramSessionClientOptions;
  hostConfig: Config;
  configDeps: ConfigDeps;
  deps?: Partial<LocalTelegramSessionClientDependencies>;
}): Promise<TelegramSessionClient> {
  const deps = { ...defaultDependencies, ...options.deps };
  const workspaceConfig = deps.loadConfig(options.client.cwd, options.configDeps);
  const clientTools = deps.createCommandClientTools(workspaceConfig.clientTools ?? []);

  return await deps.createSdkClient(
    {
      ...options.client,
      initialize: { client: { name: "tau-telegram", version: "1" } },
      clientTools,
    },
    options.hostConfig,
  );
}
