import { createTauSdkClientWithHostConfig } from "../../sdk/local_client.js";
import type { TauSdkHostDiagnostic } from "../../sdk/types.js";
import type { Config } from "../config/schema.js";
import type { RemoteModelCatalog } from "../models/remote_catalog.js";
import type { TelegramSessionClient, TelegramSessionClientOptions } from "./session_manager.js";

type LocalTelegramSessionClientDependencies = {
  createSdkClient: typeof createTauSdkClientWithHostConfig;
};

const defaultDependencies: LocalTelegramSessionClientDependencies = {
  createSdkClient: createTauSdkClientWithHostConfig,
};

export async function createLocalTelegramSessionClient(options: {
  client: TelegramSessionClientOptions;
  hostConfig: Config;
  remoteModelCatalog: RemoteModelCatalog;
  reportDiagnostic?: (diagnostic: TauSdkHostDiagnostic) => void;
  deps?: Partial<LocalTelegramSessionClientDependencies>;
}): Promise<TelegramSessionClient> {
  const deps = { ...defaultDependencies, ...options.deps };
  return await deps.createSdkClient(
    {
      cwd: options.client.cwd,
      ...(options.client.persona !== undefined ? { persona: options.client.persona } : {}),
      initialize: { client: { name: "tau-telegram", version: "1" } },
      clientTools: options.client.clientTools,
      ...(options.reportDiagnostic ? { onDiagnostic: options.reportDiagnostic } : {}),
    },
    options.hostConfig,
    { remoteModelCatalog: options.remoteModelCatalog },
  );
}
