import { getEnvApiKey } from "@mariozechner/pi-ai";
import type { Config } from "../config/schema.js";
import { getApiKeyForProvider } from "../config/schema.js";
import { resolveProviderApiKey } from "../models/catalog.js";
import { AuthManager } from "./auth_manager.js";
import type { AuthStorage } from "./auth_storage.js";

export type CredentialResolver = {
  getApiKey: (provider: string, options?: { sessionId?: string }) => Promise<string | undefined>;
  noteProviderError?: (
    provider: string,
    options?: { sessionId?: string; error?: unknown },
  ) => Promise<void>;
};

export function createCredentialResolver(options: {
  authStorage: AuthStorage;
  getConfig: () => Config;
}): CredentialResolver {
  const authManager = new AuthManager(options.authStorage);
  return {
    getApiKey: async (provider, getOptions) => {
      const authKey = await authManager.getApiKey(provider, { sessionId: getOptions?.sessionId });
      if (authKey) {
        return authKey;
      }

      const config = options.getConfig();
      const extensionApiKey = resolveProviderApiKey({
        provider,
        apiKeys: config.apiKeys,
        env: process.env,
      });
      if (extensionApiKey) {
        return extensionApiKey;
      }

      const configKey = getApiKeyForProvider(config, provider);
      if (configKey) {
        return configKey;
      }

      return getEnvApiKey(provider);
    },
    noteProviderError: async (provider, getOptions) => {
      await authManager.noteProviderError(provider, {
        sessionId: getOptions?.sessionId,
        error: getOptions?.error,
      });
    },
  };
}
