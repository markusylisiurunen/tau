import type { OAuthCredential } from "@earendil-works/pi-ai";
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
        const candidateAccountId = forcedAccountId ?? adapter.selectAccountFromList?.(accounts);
        const selectedAccountId = accounts.some(
          (account) => account.accountId === candidateAccountId && !account.disabled,
        )
          ? candidateAccountId
          : undefined;
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

  addOAuthAccount(providerId: string, credentials: OAuthCredential): void {
    const adapter = this.getAdapter(providerId);
    this.authStorage.reload();
    adapter.validateOAuthCredentials?.(credentials);
    adapter.addOAuthAccount(this.authStorage, credentials);
  }

  removeAccount(providerId: string, accountId: string): void {
    const adapter = this.getAdapter(providerId);
    this.authStorage.reload();
    const removed = adapter.removeAccount(this.authStorage, accountId);
    if (!removed) {
      throw new Error(`account "${accountId}" not found for provider "${providerId}"`);
    }
  }

  setAccountEnabled(providerId: string, accountId: string, enabled: boolean): void {
    const adapter = this.getAdapter(providerId);
    this.authStorage.reload();
    const updated = adapter.setAccountEnabled(this.authStorage, accountId, enabled);
    if (!updated) {
      throw new Error(`account "${accountId}" not found for provider "${providerId}"`);
    }
  }

  private getAdapter(providerId: string): AuthProviderAdapter {
    const adapter = this.adapters.get(providerId);
    if (!adapter) {
      throw new Error(`unsupported auth provider "${providerId}"`);
    }
    return adapter;
  }
}
