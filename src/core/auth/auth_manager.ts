import type { KnownProvider, OAuthCredentials } from "@mariozechner/pi-ai";
import type { AuthStorage } from "./auth_storage.js";
import type { AuthProviderAdapter } from "./provider_adapter.js";
import { OpenAICodexAdapter } from "./providers/openai_codex.js";
import type { AuthAccountInfo } from "./types.js";

export type AuthProviderAccounts = {
  providerId: string;
  providerLabel: string;
  accounts: AuthAccountInfo[];
  selectedAccountId?: string;
};

export class AuthManager {
  private static sessionSelections = new Map<string, Map<string, string>>();
  private readonly adapters: Map<string, AuthProviderAdapter>;

  constructor(
    private readonly authStorage: AuthStorage,
    adapters?: AuthProviderAdapter[],
  ) {
    const defaultAdapters = adapters ?? [new OpenAICodexAdapter()];
    this.adapters = new Map(defaultAdapters.map((adapter) => [adapter.id, adapter]));
  }

  listProviders(): { id: string; label: string }[] {
    return [...this.adapters.values()].map((adapter) => ({
      id: adapter.id,
      label: adapter.label,
    }));
  }

  async listProviderAccounts(): Promise<AuthProviderAccounts[]> {
    this.authStorage.reload();
    const invalidReason = this.authStorage.getInvalidReason();
    if (invalidReason) {
      throw new Error(invalidReason);
    }

    const results: AuthProviderAccounts[] = [];
    for (const adapter of this.adapters.values()) {
      const accounts = await adapter.listAccountInfo(this.authStorage);
      if (accounts.length > 0) {
        const forcedAccountId = adapter.getForcedAccountId?.(this.authStorage);
        const selectedAccountId = forcedAccountId ?? adapter.selectAccountFromList?.(accounts);
        results.push({
          providerId: adapter.id,
          providerLabel: adapter.label,
          accounts,
          selectedAccountId,
        });
      }
    }
    return results;
  }

  addOAuthAccount(providerId: string, credentials: OAuthCredentials & { idToken: string }): void {
    const adapter = this.adapters.get(providerId);
    if (!adapter) {
      throw new Error(`unsupported auth provider "${providerId}"`);
    }
    this.authStorage.reload();
    adapter.addOAuthAccount(this.authStorage, credentials);
  }

  removeAccount(providerId: string, accountId: string): void {
    const adapter = this.adapters.get(providerId);
    if (!adapter) {
      throw new Error(`unsupported auth provider "${providerId}"`);
    }
    this.authStorage.reload();
    const removed = adapter.removeAccount(this.authStorage, accountId);
    if (!removed) {
      throw new Error(`account "${accountId}" not found for provider "${providerId}"`);
    }
  }

  async getApiKey(
    provider: KnownProvider,
    options?: { sessionId?: string },
  ): Promise<string | undefined> {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      return undefined;
    }

    this.authStorage.reload();
    const invalidReason = this.authStorage.getInvalidReason();
    if (invalidReason) {
      throw new Error(invalidReason);
    }

    const forcedAccountId = adapter.getForcedAccountId?.(this.authStorage);
    if (forcedAccountId) {
      const apiKey = await adapter.getApiKeyForAccount(this.authStorage, forcedAccountId);
      if (apiKey) {
        if (options?.sessionId) {
          AuthManager.setSelectedAccount(options.sessionId, adapter.id, forcedAccountId);
        }
        return apiKey;
      }
      return undefined;
    }

    const sessionId = options?.sessionId;
    if (sessionId) {
      const selectedAccountId = AuthManager.getSelectedAccount(sessionId, adapter.id);
      if (selectedAccountId) {
        const apiKey = await adapter.getApiKeyForAccount(this.authStorage, selectedAccountId);
        if (apiKey) {
          const usable = adapter.isAccountUsable
            ? await adapter.isAccountUsable(this.authStorage, selectedAccountId, { apiKey })
            : true;
          if (usable) {
            return apiKey;
          }
        }
        AuthManager.clearSelectedAccount(sessionId, adapter.id);
      }
    }

    const selection = await adapter.selectAccount(this.authStorage);
    if (!selection) {
      return undefined;
    }
    if (sessionId) {
      AuthManager.setSelectedAccount(sessionId, adapter.id, selection.accountId);
    }
    return selection.apiKey;
  }

  async noteProviderError(
    provider: KnownProvider,
    options?: { sessionId?: string; error?: unknown },
  ): Promise<void> {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      return;
    }

    this.authStorage.reload();
    const invalidReason = this.authStorage.getInvalidReason();
    if (invalidReason) {
      throw new Error(invalidReason);
    }

    const sessionId = options?.sessionId;
    if (!sessionId) return;
    const forcedAccountId = adapter.getForcedAccountId?.(this.authStorage);
    const selectedAccountId =
      forcedAccountId ?? AuthManager.getSelectedAccount(sessionId, adapter.id);
    if (!selectedAccountId) return;

    if (!adapter.handleProviderError) {
      return;
    }

    const shouldClear = await adapter.handleProviderError(
      this.authStorage,
      selectedAccountId,
      options?.error,
    );
    if (shouldClear && !forcedAccountId) {
      AuthManager.clearSelectedAccount(sessionId, adapter.id);
    }
  }

  private static getSelectedAccount(sessionId: string, providerId: string): string | undefined {
    return AuthManager.sessionSelections.get(sessionId)?.get(providerId);
  }

  private static setSelectedAccount(
    sessionId: string,
    providerId: string,
    accountId: string,
  ): void {
    let selections = AuthManager.sessionSelections.get(sessionId);
    if (!selections) {
      selections = new Map();
      AuthManager.sessionSelections.set(sessionId, selections);
    }
    selections.set(providerId, accountId);
  }

  private static clearSelectedAccount(sessionId: string, providerId: string): void {
    const selections = AuthManager.sessionSelections.get(sessionId);
    if (!selections) return;
    selections.delete(providerId);
    if (selections.size === 0) {
      AuthManager.sessionSelections.delete(sessionId);
    }
  }
}
