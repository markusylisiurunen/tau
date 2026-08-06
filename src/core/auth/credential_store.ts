import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import type { Config } from "../config/schema.js";
import { getApiKeyForProvider } from "../config/schema.js";
import { resolveProviderApiKey } from "../models/catalog.js";
import type { AuthStorage } from "./auth_storage.js";
import { decodeJwtPayload } from "./jwt.js";
import { OpenAICodexAdapter } from "./providers/openai_codex.js";
import type { StoredAccount, StoredOAuthAccount } from "./types.js";

const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
const FORCED_CODEX_ACCOUNT_ENV = "TAU_CODEX_ACCOUNT";
const codexAdapter = new OpenAICodexAdapter();
const codexSessionSelections = new Map<string, string>();

type CredentialStoreOptions = {
  authStorage: AuthStorage;
  getConfig: () => Config;
  env?: NodeJS.ProcessEnv;
  getSessionId?: () => string | undefined;
};

export class TauCredentialStore implements CredentialStore {
  constructor(private readonly options: CredentialStoreOptions) {}

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    const stored = await this.readStoredCredential(providerId, options?.signal);
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
    const current = await this.readStoredCredential(providerId, options?.signal);
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

      const target = provider ?? { accounts: [] };
      data.providers[providerId] = target;
      const existingIndex = target.accounts.findIndex((entry) => entry.accountId === accountId);
      if (existingIndex >= 0) {
        target.accounts[existingIndex] = nextAccount;
      } else {
        target.accounts.push(nextAccount);
      }
      return nextAccount;
    });

    if (providerId === OPENAI_CODEX_PROVIDER_ID && stored?.type === "oauth" && stored.disabled) {
      return undefined;
    }
    return stored ? credentialFromStoredAccount(stored) : undefined;
  }

  async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    options?.signal?.throwIfAborted();
    this.options.authStorage.update((data) => {
      delete data.providers[providerId];
    });
  }

  async noteProviderError(
    providerId: string,
    options?: { sessionId?: string; error?: unknown },
  ): Promise<void> {
    if (providerId !== OPENAI_CODEX_PROVIDER_ID) {
      return;
    }

    this.options.authStorage.reload();
    const invalidReason = this.options.authStorage.getInvalidReason();
    if (invalidReason) {
      throw new Error(invalidReason);
    }

    const sessionId = options?.sessionId ?? this.options.getSessionId?.();
    if (!sessionId) {
      return;
    }

    const forcedAccount = getForcedCodexAccount(
      this.options.authStorage,
      this.options.env ?? process.env,
    );
    const selectedAccountId =
      forcedAccount?.accountId ??
      codexSessionSelections.get(getCodexSessionSelectionKey(sessionId));
    if (!selectedAccountId) {
      return;
    }

    const shouldClear = await codexAdapter.handleProviderError(
      this.options.authStorage,
      selectedAccountId,
      options?.error,
    );
    if (shouldClear && !forcedAccount) {
      clearCodexSessionSelection(sessionId);
    }
  }

  private async readStoredCredential(
    providerId: string,
    signal?: AbortSignal,
  ): Promise<{ credential: Credential; accountId: string; account: StoredAccount } | undefined> {
    this.options.authStorage.reload();
    const invalidReason = this.options.authStorage.getInvalidReason();
    if (invalidReason) {
      throw new Error(invalidReason);
    }

    const provider = this.options.authStorage.getData().providers[providerId];
    if (!provider || provider.accounts.length === 0) {
      return undefined;
    }

    const account =
      providerId === OPENAI_CODEX_PROVIDER_ID
        ? await selectCodexAccount(
            this.options.authStorage,
            this.options.env ?? process.env,
            this.options.getSessionId?.(),
            signal,
          )
        : provider.accounts[0];
    if (!account) {
      return undefined;
    }

    return {
      credential: credentialFromStoredAccount(account),
      accountId: account.accountId,
      account,
    };
  }

  private readConfiguredCredential(providerId: string): Credential | undefined {
    const config = this.options.getConfig();
    const env = this.options.env ?? process.env;
    const extensionApiKey = resolveProviderApiKey({
      provider: providerId,
      apiKeys: config.apiKeys,
      env,
    });
    const key = extensionApiKey ?? getApiKeyForProvider(config, providerId);
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
    a.disabled === b.disabled &&
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

  return {
    type: "oauth",
    accountId,
    disabled: current?.type === "oauth" ? current.disabled : false,
    providerAccountId: stringValue(credential.accountId),
    access: credential.access,
    refresh: credential.refresh,
    expires: credential.expires,
    enterpriseUrl: stringValue(credential.enterpriseUrl),
    projectId: stringValue(credential.projectId),
  } satisfies StoredOAuthAccount;
}

async function selectCodexAccount(
  authStorage: AuthStorage,
  env: NodeJS.ProcessEnv,
  sessionId?: string,
  signal?: AbortSignal,
): Promise<StoredAccount | undefined> {
  signal?.throwIfAborted();
  const forcedAccount = getForcedCodexAccount(authStorage, env);
  if (forcedAccount) {
    if (sessionId) {
      setCodexSessionSelection(sessionId, forcedAccount.accountId);
    }
    const apiKey = await codexAdapter.getApiKeyForAccount(authStorage, forcedAccount.accountId, {
      signal,
    });
    if (!apiKey) {
      if (sessionId) {
        clearCodexSessionSelection(sessionId);
      }
      return undefined;
    }
    const currentAccount = getStoredAccountById(
      authStorage,
      OPENAI_CODEX_PROVIDER_ID,
      forcedAccount.accountId,
    );
    if (currentAccount?.type === "oauth" && currentAccount.disabled) {
      throwDisabledCodexAccountError(currentAccount.accountId);
    }
    return currentAccount;
  }

  if (sessionId) {
    const selectedAccountId = codexSessionSelections.get(getCodexSessionSelectionKey(sessionId));
    if (selectedAccountId) {
      const selectedAccount = getStoredAccountById(
        authStorage,
        OPENAI_CODEX_PROVIDER_ID,
        selectedAccountId,
      );
      if (selectedAccount?.type === "oauth" && !selectedAccount.disabled) {
        const apiKey = await codexAdapter.getApiKeyForAccount(authStorage, selectedAccountId, {
          signal,
        });
        const usable = apiKey
          ? await codexAdapter.isAccountUsable(authStorage, selectedAccountId, { apiKey, signal })
          : false;
        if (usable) {
          return getStoredAccountById(authStorage, OPENAI_CODEX_PROVIDER_ID, selectedAccountId);
        }
      }
      clearCodexSessionSelection(sessionId);
    }
  }

  const selection = await codexAdapter.selectAccount(authStorage, { signal });
  signal?.throwIfAborted();
  if (!selection) {
    return undefined;
  }

  const selectedAccount = getStoredAccountById(
    authStorage,
    OPENAI_CODEX_PROVIDER_ID,
    selection.accountId,
  );
  if (selectedAccount?.type !== "oauth" || selectedAccount.disabled) {
    return undefined;
  }

  if (sessionId) {
    setCodexSessionSelection(sessionId, selection.accountId);
  }

  return selectedAccount;
}

function getForcedCodexAccount(
  authStorage: AuthStorage,
  env: NodeJS.ProcessEnv,
): StoredAccount | undefined {
  const forced = env[FORCED_CODEX_ACCOUNT_ENV]?.trim().toLowerCase();
  if (!forced) {
    return undefined;
  }

  const account = getStoredAccounts(authStorage, OPENAI_CODEX_PROVIDER_ID).find((candidate) =>
    accountMatchesCodexIdentifier(candidate, forced),
  );
  if (!account) {
    throw new Error(
      `${FORCED_CODEX_ACCOUNT_ENV} did not match any stored Codex account: "${env[FORCED_CODEX_ACCOUNT_ENV]}". ` +
        'Run "tau auth list" to see available accounts.',
    );
  }
  if (account.type === "oauth" && account.disabled) {
    throwDisabledCodexAccountError(account.accountId);
  }

  return account;
}

function throwDisabledCodexAccountError(accountId: string): never {
  throw new Error(
    `${FORCED_CODEX_ACCOUNT_ENV} matched disabled Codex account "${accountId}". ` +
      `Run "tau auth enable codex --account ${accountId}" to enable it.`,
  );
}

function getStoredAccountById(
  authStorage: AuthStorage,
  providerId: string,
  accountId: string,
): StoredAccount | undefined {
  return getStoredAccounts(authStorage, providerId).find(
    (account) => account.accountId === accountId,
  );
}

function getStoredAccounts(authStorage: AuthStorage, providerId: string): StoredAccount[] {
  return authStorage.getData().providers[providerId]?.accounts ?? [];
}

function getCodexSessionSelectionKey(sessionId: string): string {
  return `${OPENAI_CODEX_PROVIDER_ID}:${sessionId}`;
}

function setCodexSessionSelection(sessionId: string, accountId: string): void {
  codexSessionSelections.set(getCodexSessionSelectionKey(sessionId), accountId);
}

function clearCodexSessionSelection(sessionId: string): void {
  codexSessionSelections.delete(getCodexSessionSelectionKey(sessionId));
}

function accountMatchesCodexIdentifier(account: StoredAccount, value: string): boolean {
  if (account.accountId.trim().toLowerCase() === value) {
    return true;
  }

  if (account.type !== "oauth") {
    return false;
  }

  if (account.providerAccountId?.trim().toLowerCase() === value) {
    return true;
  }

  return getCodexAccountEmail(account)?.toLowerCase() === value;
}

function getCodexAccountEmail(account: StoredOAuthAccount): string | undefined {
  const payload = decodeJwtPayload(account.access);
  if (!payload) {
    return undefined;
  }

  const profile = asRecord(payload["https://api.openai.com/profile"]);
  return stringValue(payload.email) ?? stringValue(profile?.email);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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
