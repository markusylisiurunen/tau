import { createDefaultConfigDeps } from "../core/config/deps.js";
import { loadConfig } from "../core/config/schema.js";
import { createDefaultCoreDeps } from "../core/runtime/deps.js";
import { WebSocketSessionProtocolTransport } from "../transport/index.js";
import { createTauSdkClientWithHostConfig } from "./local_client.js";
import { createTauSdkClientFromTransport, resolveTauSdkInitializeParams } from "./session.js";
import type { TauSdkClient, TauSdkClientOptions, TauSdkWebSocketClientOptions } from "./types.js";

export async function createTauSdkClient(options: TauSdkClientOptions = {}): Promise<TauSdkClient> {
  const deps = createDefaultCoreDeps();
  const config = loadConfig(options.cwd ?? deps.env.cwd(), createDefaultConfigDeps());
  return await createTauSdkClientWithHostConfig(options, config);
}

export async function createTauSdkWebSocketClient(
  options: TauSdkWebSocketClientOptions,
): Promise<TauSdkClient> {
  resolveTauSdkInitializeParams(options.initialize, options.clientTools);
  const transport = new WebSocketSessionProtocolTransport(options);
  return createTauSdkClientFromTransport(transport, options);
}
