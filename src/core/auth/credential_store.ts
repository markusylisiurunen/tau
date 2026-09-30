import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { defaultProviderAuthContext } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { Config } from "../config/schema.js";
import { getApiKeyForProvider } from "../config/schema.js";
import type { AuthStorage } from "./auth_storage.js";
import type { StoredAccount, StoredOAuthAccount } from "./types.js";

const OPENAI_CODEX_PROVIDER_ID = "openai-codex";

type CredentialStoreOptions = {
  authStorage: AuthStorage;
  getConfig: () => Config;
  env?: NodeJS.ProcessEnv;
};

export class TauCredentialStore implements CredentialStore {
  private codexAccountId?: string;

  constructor(private readonly options: CredentialStoreOptions) {}

  bindCodexAccount(): TauCredentialStore {
    const account = this.readStoredCredential(OPENAI_CODEX_PROVIDER_ID);
    if (!account) throwMissingActiveAccount();
    const store = new TauCredentialStore(this.options);
    store.codexAccountId = account.accountId;
    return store;
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    if (providerId !== OPENAI_CODEX_PROVIDER_ID) {
      const base = defaultProviderAuthContext();
      const env = this.options.env ?? process.env;
      const ambient = await builtinProviders()
        .find((provider) => provider.id === providerId)
        ?.auth.apiKey?.resolve({
          ctx: {
            env: async (name) => env[name]?.trim() || undefined,
            fileExists: (path) => base.fileExists(path),
          },
          signal: options?.signal ?? new AbortController().signal,
        });
      if (ambient) return undefined;
      const configured = this.readConfiguredCredential(providerId);
      if (configured) return configured;
    }
    const stored = this.readStoredCredential(providerId);
    options?.signal?.throwIfAborted();
    if (stored) {
      return stored.credential;
    }

    return this.readConfiguredCredential(providerId);
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    this.options.authStorage.reload();
    const invalidReason = this.options.authStorage.getInvalidReason();
    if (invalidReason) {
      throw new Error(invalidReason);
    }

    return Object.entries(this.options.authStorage.getData().providers).flatMap(
      ([providerId, provider]) => {
        const account = provider.accounts[0];
        return account ? [{ providerId, type: account.type }] : [];
      },
    );
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    const store =
      providerId === OPENAI_CODEX_PROVIDER_ID && !this.codexAccountId
        ? this.bindCodexAccount()
        : this;
    const account = store.readStoredCredential(providerId);
    const accountId = account?.accountId ?? store.codexAccountId ?? getDefaultAccountId(providerId);
    return await this.options.authStorage.withAccountLock(
      providerId,
      accountId,
      async () => {
        const current = store.readStoredCredential(providerId);
        if (store.codexAccountId && !current) return undefined;
        options?.signal?.throwIfAborted();
        const next = await fn(current?.credential);
        options?.signal?.throwIfAborted();
        if (!next) {
          return current?.credential;
        }

        const accountId =
          current?.accountId ?? getCredentialAccountId(next) ?? getDefaultAccountId(providerId);
        const expected = current?.account;
        const nextAccount = storedAccountFromCredential(next, accountId, current?.account);
        const stored = this.options.authStorage.update((data): StoredAccount | undefined => {
          const provider = data.providers[providerId];
          const existing = provider?.accounts.find((entry) => entry.accountId === accountId);
          if (expected) {
            if (!existing) {
              return undefined;
            }
            if (!hasSameStoredCredentialGeneration(existing, expected)) {
              return existing;
            }
          } else if (existing) {
            return existing;
          }

          const target = provider ?? { accounts: [], activeAccountId: null };
          data.providers[providerId] = target;
          const existingIndex = target.accounts.findIndex((entry) => entry.accountId === accountId);
          if (existingIndex >= 0) {
            target.accounts[existingIndex] = nextAccount;
          } else {
            target.accounts.push(nextAccount);
          }
          return nextAccount;
        });

        return stored ? credentialFromStoredAccount(stored) : undefined;
      },
      options?.signal,
    );
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    options?.signal?.throwIfAborted();
    this.options.authStorage.update((data) => {
      delete data.providers[providerId];
    });
  }

  private readStoredCredential(
    providerId: string,
  ): { credential: Credential; accountId: string; account: StoredAccount } | undefined {
    this.options.authStorage.reload();
    const invalidReason = this.options.authStorage.getInvalidReason();
    if (invalidReason) {
      throw new Error(invalidReason);
    }

    const provider = this.options.authStorage.getData().providers[providerId];
    if (!provider || provider.accounts.length === 0) {
      if (providerId === OPENAI_CODEX_PROVIDER_ID && !this.codexAccountId)
        throwMissingActiveAccount();
      return undefined;
    }

    const account =
      providerId === OPENAI_CODEX_PROVIDER_ID
        ? provider.accounts.find(
            (entry) => entry.accountId === (this.codexAccountId ?? provider.activeAccountId),
          )
        : provider.accounts[0];
    if (!account) {
      if (providerId === OPENAI_CODEX_PROVIDER_ID && !this.codexAccountId)
        throwMissingActiveAccount();
      return undefined;
    }
    if (providerId === OPENAI_CODEX_PROVIDER_ID && account.type !== "oauth")
      throwMissingActiveAccount();

    return {
      credential: credentialFromStoredAccount(account),
      accountId: account.accountId,
      account,
    };
  }

  private readConfiguredCredential(providerId: string): Credential | undefined {
    const key = getApiKeyForProvider(this.options.getConfig(), providerId);
    return key ? { type: "api_key", key } : undefined;
  }
}

function credentialFromStoredAccount(account: StoredAccount): Credential {
  if (account.type === "api_key") {
    return { type: "api_key", key: account.key };
  }

  return {
    type: "oauth",
    access: account.access,
    refresh: account.refresh,
    expires: account.expires,
    ...(account.providerAccountId ? { accountId: account.providerAccountId } : {}),
    ...(account.enterpriseUrl ? { enterpriseUrl: account.enterpriseUrl } : {}),
    ...(account.projectId ? { projectId: account.projectId } : {}),
  };
}

function hasSameStoredCredentialGeneration(a: StoredAccount, b: StoredAccount): boolean {
  if (a.type !== b.type || a.accountId !== b.accountId) {
    return false;
  }
  if (a.type === "api_key" && b.type === "api_key") {
    return a.key === b.key;
  }
  if (a.type !== "oauth" || b.type !== "oauth") {
    return false;
  }
  return (
    a.providerAccountId === b.providerAccountId &&
    a.access === b.access &&
    a.refresh === b.refresh &&
    a.expires === b.expires &&
    a.enterpriseUrl === b.enterpriseUrl &&
    a.projectId === b.projectId
  );
}

function storedAccountFromCredential(
  credential: Credential,
  accountId: string,
  current?: StoredAccount,
): StoredAccount {
  if (credential.type === "api_key") {
    const key = stringValue(credential.key);
    if (!key) {
      throw new Error(`api key credential for "${accountId}" is missing a key`);
    }

    return {
      type: "api_key",
      accountId,
      key,
    };
  }

  const stored = current?.type === "oauth" ? current : undefined;
  return {
    ...stored,
    type: "oauth",
    accountId,
    providerAccountId: stringValue(credential.accountId) ?? stored?.providerAccountId,
    access: credential.access,
    refresh: credential.refresh,
    expires: credential.expires,
    enterpriseUrl: stringValue(credential.enterpriseUrl) ?? stored?.enterpriseUrl,
    projectId: stringValue(credential.projectId) ?? stored?.projectId,
  } satisfies StoredOAuthAccount;
}

function throwMissingActiveAccount(): never {
  throw new Error(
    'no active Codex account; run "tau auth login codex" or "tau auth use codex --account <email-or-id>".',
  );
}

function getCredentialAccountId(credential: Credential): string | undefined {
  if (credential.type === "oauth") {
    return stringValue(credential.accountId);
  }

  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function getDefaultAccountId(providerId: string): string {
  return `${providerId}:default`;
}
