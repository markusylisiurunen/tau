import type { KnownProvider } from "@mariozechner/pi-ai";
import { getEnvApiKey } from "@mariozechner/pi-ai";
import type { Config } from "../config/schema.js";
import { getApiKeyForProvider } from "../config/schema.js";
import { AuthManager } from "./auth_manager.js";
import type { AuthStorage } from "./auth_storage.js";

export type CredentialResolver = {
  getApiKey: (
    provider: KnownProvider,
    options?: { sessionId?: string },
  ) => Promise<string | undefined>;
  noteProviderError?: (
    provider: KnownProvider,
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

      const configKey = getApiKeyForProvider(options.getConfig(), provider);
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
