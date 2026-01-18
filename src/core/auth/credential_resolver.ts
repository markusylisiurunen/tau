import type { KnownProvider } from "@mariozechner/pi-ai";
import { getEnvApiKey } from "@mariozechner/pi-ai";
import type { Config } from "../config/schema.js";
import { getApiKeyForProvider } from "../config/schema.js";
import type { AuthStorage } from "./auth_storage.js";

export type CredentialResolver = {
  getApiKey: (provider: KnownProvider) => Promise<string | undefined>;
};

export function createCredentialResolver(options: {
  authStorage: AuthStorage;
  getConfig: () => Config;
}): CredentialResolver {
  return {
    getApiKey: async (provider) => {
      const authKey = await options.authStorage.getApiKey(provider);
      if (authKey) {
        return authKey;
      }

      const configKey = getApiKeyForProvider(options.getConfig(), provider);
      if (configKey) {
        return configKey;
      }

      return getEnvApiKey(provider);
    },
  };
}
