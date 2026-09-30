import type { OAuthCredential } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { AuthStorage } from "../auth_storage.js";
import type { AuthProviderAdapter } from "../provider_adapter.js";
import type { AuthAccountInfo, StoredOAuthAccount } from "../types.js";

const ACCOUNT_ID = "openai:default";
const registrationSchema = z.object({
  clientId: z.string().trim().min(1),
  scopes: z
    .array(z.string().min(1))
    .refine((scopes) => scopes.includes("chatgpt.tokens.use.direct")),
});

export class OpenAIAdapter implements AuthProviderAdapter {
  readonly id = "openai";
  readonly label = "OpenAI (ChatGPT)";

  validateOAuthCredentials(credentials: OAuthCredential): void {
    if (!registrationSchema.safeParse(credentials).success) {
      throw new Error("ChatGPT credentials require an issued client ID and direct token scope");
    }
  }

  addOAuthAccount(authStorage: AuthStorage, credentials: OAuthCredential): void {
    const registration = registrationSchema.parse(credentials);
    authStorage.update((data) => {
      const existing = data.providers.openai?.accounts.find(
        (entry) => entry.accountId === ACCOUNT_ID,
      );
      data.providers.openai = {
        accounts: [
          {
            type: "oauth",
            accountId: ACCOUNT_ID,
            disabled: existing?.type === "oauth" && existing.disabled,
            access: credentials.access,
            refresh: credentials.refresh,
            expires: credentials.expires,
            clientId: registration.clientId,
            scopes: registration.scopes,
          },
        ],
      };
    });
  }

  removeAccount(authStorage: AuthStorage, accountId: string): boolean {
    return authStorage.update((data) => {
      const provider = data.providers.openai;
      if (!provider?.accounts.some((entry) => entry.accountId === accountId)) return false;
      provider.accounts = provider.accounts.filter((entry) => entry.accountId !== accountId);
      return true;
    });
  }

  setAccountEnabled(authStorage: AuthStorage, accountId: string, enabled: boolean): boolean {
    return authStorage.update((data) => {
      const account = data.providers.openai?.accounts.find(
        (entry) => entry.accountId === accountId,
      );
      if (account?.type !== "oauth") return false;
      account.disabled = !enabled;
      return true;
    });
  }

  async listAccountInfo(authStorage: AuthStorage): Promise<AuthAccountInfo[]> {
    const account = getAccount(authStorage);
    if (!account) return [];
    return [
      {
        provider: this.id,
        accountId: account.accountId,
        disabled: account.disabled,
        credentialExpired: Date.now() >= account.expires,
        credentialRefreshStatus: "not-requested",
        usageRefreshStatus: "unsupported",
      },
    ];
  }

  selectAccountFromList(accounts: AuthAccountInfo[]): string | undefined {
    return accounts.find((account) => !account.disabled)?.accountId;
  }
}

function getAccount(authStorage: AuthStorage): StoredOAuthAccount | undefined {
  const account = authStorage
    .getData()
    .providers.openai?.accounts.find((entry) => entry.accountId === ACCOUNT_ID);
  return account?.type === "oauth" ? account : undefined;
}
