import type { OAuthCredentials, OAuthProvider } from "@mariozechner/pi-ai";
import { getOAuthApiKey } from "@mariozechner/pi-ai";
import type { AuthStorage } from "../auth_storage.js";
import { decodeJwtPayload } from "../jwt.js";
import type { AuthProviderAdapter, AuthProviderSelection } from "../provider_adapter.js";
import type {
  AuthAccountInfo,
  AuthAccountUsage,
  AuthAccountUsageWindow,
  AuthStorageData,
  StoredOAuthAccount,
} from "../types.js";

const PROVIDER_ID = "openai-codex";
const PROVIDER_LABEL = "OpenAI Codex";
const USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const FORCED_ACCOUNT_ENV = "TAU_CODEX_ACCOUNT";

type CodexAccount = StoredOAuthAccount;
type UnknownRecord = Record<string, unknown>;
type AccountPriorityCandidate = { usage?: AuthAccountUsage; index: number };

export class OpenAICodexAdapter implements AuthProviderAdapter {
  readonly id = PROVIDER_ID;
  readonly label = PROVIDER_LABEL;

  validateOAuthCredentials(credentials: OAuthCredentials): void {
    assertCodexClaims(credentials);
  }

  addOAuthAccount(authStorage: AuthStorage, credentials: OAuthCredentials): void {
    const claims = assertCodexClaims(credentials);
    const accountId = claims.accountId;
    const account: CodexAccount = {
      type: "oauth",
      accountId,
      providerAccountId: normalizeString(credentials.accountId) ?? claims.accountId,
      access: credentials.access,
      refresh: credentials.refresh,
      expires: credentials.expires,
      enterpriseUrl: normalizeString(credentials.enterpriseUrl),
      projectId: normalizeString(credentials.projectId),
    };

    authStorage.update((data) => {
      const providerData = ensureProvider(data, PROVIDER_ID);
      const existingIndex = providerData.accounts.findIndex(
        (entry) => entry.type === "oauth" && entry.accountId === accountId,
      );
      if (existingIndex >= 0) {
        providerData.accounts[existingIndex] = account;
      } else {
        providerData.accounts.push(account);
      }
    });
  }

  removeAccount(authStorage: AuthStorage, accountId: string): boolean {
    const normalizedId = normalizeIdentifier(accountId);
    let removed = false;
    authStorage.update((data) => {
      const providerData = ensureProvider(data, PROVIDER_ID);
      providerData.accounts = providerData.accounts.filter((account) => {
        if (account.type !== "oauth" || !matchesIdentifier(account, normalizedId)) {
          return true;
        }
        removed = true;
        return false;
      });
    });
    return removed;
  }

  async listAccountInfo(authStorage: AuthStorage): Promise<AuthAccountInfo[]> {
    const accounts = getAccounts(authStorage);
    if (accounts.length === 0) return [];

    return Promise.all(
      accounts.map(async (account) => {
        const identity = decodeIdentity(account.access);
        const usage = await this.getUsageSnapshot(authStorage, account, { forceRefresh: true });
        return {
          provider: PROVIDER_ID,
          accountId: account.accountId,
          email: identity.email,
          plan: identity.plan,
          usage,
        } satisfies AuthAccountInfo;
      }),
    );
  }

  async selectAccount(authStorage: AuthStorage): Promise<AuthProviderSelection | undefined> {
    const accounts = getAccounts(authStorage);
    if (accounts.length === 0) return undefined;

    const forcedAccountId = this.getForcedAccountId(authStorage);
    if (forcedAccountId) {
      const apiKey = await this.getApiKeyForAccount(authStorage, forcedAccountId);
      return apiKey ? { accountId: forcedAccountId, apiKey } : undefined;
    }

    const now = nowSeconds();
    const candidates = accounts.map((account, index) => ({ account, index, usage: account.usage }));
    candidates.sort((a, b) => compareAccountPriority(a, b, now));

    for (const candidate of candidates) {
      const apiKey = await this.getApiKeyForAccount(authStorage, candidate.account.accountId);
      if (!apiKey) continue;

      let usage = candidate.usage;
      if (!isUsageUsable(usage, now) || !usage || isUsageExpired(usage, now)) {
        const refreshed = await this.getUsageSnapshot(authStorage, candidate.account, {
          apiKey,
          forceRefresh: true,
        });
        usage = refreshed ?? usage;
      }

      if (isUsageUsable(usage, now)) {
        return { accountId: candidate.account.accountId, apiKey };
      }
    }

    return undefined;
  }

  selectAccountFromList(accounts: AuthAccountInfo[]): string | undefined {
    if (accounts.length === 0) return undefined;

    const forcedAccountId = getForcedAccountIdFromList(accounts);
    if (forcedAccountId) return forcedAccountId;

    const now = nowSeconds();
    const candidates = accounts
      .map((account, index) => ({ accountId: account.accountId, usage: account.usage, index }))
      .filter((candidate) => isUsageUsable(candidate.usage, now));
    if (candidates.length === 0) return undefined;

    candidates.sort((a, b) => compareAccountPriority(a, b, now));
    return candidates[0]?.accountId;
  }

  async getApiKeyForAccount(
    authStorage: AuthStorage,
    accountId: string,
  ): Promise<string | undefined> {
    const account = getAccounts(authStorage).find((entry) => entry.accountId === accountId);
    if (!account) return undefined;

    const result = await getOAuthApiKey(PROVIDER_ID as OAuthProvider, {
      [PROVIDER_ID]: toOAuthCredentials(account),
    });
    if (!result) return undefined;

    if (shouldUpdateAccount(account, result.newCredentials)) {
      updateStoredOAuthAccount(authStorage, account.accountId, (current) =>
        mergeUpdatedCredentials(current, result.newCredentials),
      );
    }

    return result.apiKey;
  }

  getForcedAccountId(authStorage: AuthStorage): string | undefined {
    return resolveForcedAccountId(authStorage);
  }

  async isAccountUsable(
    authStorage: AuthStorage,
    accountId: string,
    options?: { apiKey?: string },
  ): Promise<boolean> {
    const account = getAccounts(authStorage).find((entry) => entry.accountId === accountId);
    if (!account) return false;

    const usage = await this.getUsageSnapshot(authStorage, account, {
      apiKey: options?.apiKey,
      refreshIfExpired: true,
      refreshIfMissing: true,
    });
    return isUsageUsable(usage, nowSeconds());
  }

  async handleProviderError(
    authStorage: AuthStorage,
    accountId: string,
    _error: unknown,
  ): Promise<boolean> {
    const accounts = getAccounts(authStorage);
    if (accounts.length === 0) return false;

    const selectedAccount = accounts.find((account) => account.accountId === accountId);
    if (!selectedAccount) return false;

    const selectedUsage = await this.getUsageSnapshot(authStorage, selectedAccount, {
      forceRefresh: true,
      refreshIfMissing: true,
    });
    if (!selectedUsage || !isUsageExhausted(selectedUsage)) return false;

    for (const account of accounts) {
      if (account.accountId === accountId) continue;
      await this.getUsageSnapshot(authStorage, account, {
        forceRefresh: true,
        refreshIfMissing: true,
      });
    }

    return true;
  }

  private async getUsageSnapshot(
    authStorage: AuthStorage,
    account: CodexAccount,
    options?: {
      apiKey?: string;
      forceRefresh?: boolean;
      refreshIfExpired?: boolean;
      refreshIfMissing?: boolean;
    },
  ): Promise<AuthAccountUsage | undefined> {
    const now = nowSeconds();
    let usage = account.usage;
    const shouldRefresh =
      Boolean(options?.forceRefresh) ||
      (Boolean(options?.refreshIfMissing) && !usage) ||
      (Boolean(options?.refreshIfExpired) && usage !== undefined && isUsageExpired(usage, now));
    if (!shouldRefresh) return usage;

    try {
      const apiKey =
        options?.apiKey ?? (await this.getApiKeyForAccount(authStorage, account.accountId));
      if (!apiKey) return usage;

      const refreshedAccount =
        getAccounts(authStorage).find((entry) => entry.accountId === account.accountId) ?? account;
      const refreshedUsage = await fetchUsage(apiKey, refreshedAccount.providerAccountId);
      if (!refreshedUsage) return usage;

      usage = refreshedUsage;
      updateStoredOAuthAccount(authStorage, account.accountId, (current) => ({
        ...current,
        usage: refreshedUsage,
      }));
      return usage;
    } catch {
      return usage;
    }
  }
}

function ensureProvider(data: AuthStorageData, providerId: string) {
  if (!data.providers[providerId]) {
    data.providers[providerId] = { accounts: [] };
  }
  return data.providers[providerId]!;
}

function getAccounts(authStorage: AuthStorage): CodexAccount[] {
  const provider = authStorage.getData().providers[PROVIDER_ID];
  if (!provider) return [];
  return provider.accounts.filter((account): account is CodexAccount => account.type === "oauth");
}

function resolveForcedAccountId(authStorage: AuthStorage): string | undefined {
  const forced = readForcedAccountIdentifier();
  if (!forced) return undefined;

  const account = getAccounts(authStorage).find((entry) =>
    matchesIdentifier(entry, forced.identifier),
  );
  if (!account) {
    throw new Error(
      `${FORCED_ACCOUNT_ENV} did not match any stored Codex account: "${forced.raw}". ` +
        'Run "tau auth list" to see available accounts.',
    );
  }

  return account.accountId;
}

function getForcedAccountIdFromList(accounts: AuthAccountInfo[]): string | undefined {
  const forced = readForcedAccountIdentifier();
  if (!forced) return undefined;

  const account = accounts.find(
    (entry) =>
      entry.email?.trim().toLowerCase() === forced.identifier ||
      entry.accountId.trim().toLowerCase() === forced.identifier,
  );
  return account?.accountId;
}

function readForcedAccountIdentifier(): { raw: string; identifier: string } | undefined {
  const raw = process.env[FORCED_ACCOUNT_ENV];
  if (!raw) return undefined;

  const identifier = normalizeIdentifier(raw);
  return identifier ? { raw, identifier } : undefined;
}

function toOAuthCredentials(account: CodexAccount): OAuthCredentials {
  const credentials: OAuthCredentials = {
    refresh: account.refresh,
    access: account.access,
    expires: account.expires,
    enterpriseUrl: account.enterpriseUrl,
    projectId: account.projectId,
  };
  if (account.providerAccountId) {
    credentials.accountId = account.providerAccountId;
  }
  return credentials;
}

function assertCodexClaims(credentials: OAuthCredentials): {
  accountId: string;
  email: string;
  plan: string;
} {
  const claims = parseCodexClaims(decodeJwtPayload(credentials.access));

  const missing: string[] = [];
  if (!claims.accountId) missing.push("account id");
  if (!claims.email) missing.push("email");
  if (!claims.plan) missing.push("plan");
  if (missing.length > 0) {
    throw new Error(
      `oauth access token missing required claims: ${missing.join(", ")}. please re-authenticate.`,
    );
  }

  const providedAccountId = normalizeString(credentials.accountId);
  if (providedAccountId && providedAccountId !== claims.accountId) {
    throw new Error(
      `oauth access token account id "${claims.accountId}" does not match credentials account id "${providedAccountId}".`,
    );
  }

  return { accountId: claims.accountId!, email: claims.email!, plan: claims.plan! };
}

function decodeIdentity(accessToken: string): { email?: string; plan?: string } {
  const claims = parseCodexClaims(decodeJwtPayload(accessToken));
  return { email: claims.email, plan: claims.plan };
}

function parseCodexClaims(payload: ReturnType<typeof decodeJwtPayload>): {
  accountId?: string;
  email?: string;
  plan?: string;
} {
  if (!payload) return {};

  const profileClaims = asRecord(payload["https://api.openai.com/profile"]);
  const authClaims = asRecord(payload["https://api.openai.com/auth"]);
  return {
    email: normalizeString(payload.email) ?? normalizeString(profileClaims?.email),
    plan:
      normalizeString(authClaims?.chatgpt_plan_type) ?? normalizeString(payload.chatgpt_plan_type),
    accountId:
      normalizeString(authClaims?.chatgpt_account_id) ??
      normalizeString(payload.chatgpt_account_id),
  };
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function normalizeIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

function matchesIdentifier(account: CodexAccount, identifier: string): boolean {
  if (!identifier) return false;
  if (account.accountId.toLowerCase() === identifier) return true;
  return decodeIdentity(account.access).email?.toLowerCase() === identifier;
}

async function fetchUsage(
  apiKey: string,
  providerAccountId?: string,
): Promise<AuthAccountUsage | undefined> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
  if (providerAccountId) {
    headers["ChatGPT-Account-Id"] = providerAccountId;
  }

  const response = await fetch(USAGE_ENDPOINT, { method: "GET", headers });
  if (!response.ok) return undefined;

  const root = asRecord((await response.json()) as unknown);
  const rateLimit = asRecord(root?.rate_limit);
  if (!rateLimit) return undefined;

  const windows = [
    parseUsageWindow(rateLimit.primary_window, "primary"),
    parseUsageWindow(rateLimit.secondary_window, "secondary"),
  ].filter((window): window is AuthAccountUsageWindow => window !== undefined);
  return windows.length > 0 ? { windows } : undefined;
}

function parseUsageWindow(
  value: unknown,
  name: "primary" | "secondary",
): AuthAccountUsageWindow | undefined {
  const window = asRecord(value);
  if (!window) return undefined;

  return {
    name,
    usedPercent: clampPercent(window.used_percent),
    resetAt: normalizeNumber(window.reset_at),
    windowSeconds: normalizeNumber(window.limit_window_seconds),
  };
}

function compareAccountPriority(
  a: AccountPriorityCandidate,
  b: AccountPriorityCandidate,
  now: number,
): number {
  const activeA = hasActivePrimaryWindow(a.usage, now);
  const activeB = hasActivePrimaryWindow(b.usage, now);
  if (activeA !== activeB) return activeA ? -1 : 1;

  const usedA = getUsageUsedPercent(a.usage, now);
  const usedB = getUsageUsedPercent(b.usage, now);
  if (usedA === undefined && usedB !== undefined) return 1;
  if (usedA !== undefined && usedB === undefined) return -1;
  if (usedA !== undefined && usedB !== undefined && usedA !== usedB) {
    return usedB - usedA;
  }
  return a.index - b.index;
}

function findWindow(usage: AuthAccountUsage, name: string): AuthAccountUsageWindow | undefined {
  return usage.windows.find((window) => window.name === name);
}

function getUsageUsedPercent(usage: AuthAccountUsage | undefined, now: number): number | undefined {
  if (!usage || isUsageExpired(usage, now)) return undefined;

  return Math.max(
    findWindow(usage, "primary")?.usedPercent ?? 0,
    findWindow(usage, "secondary")?.usedPercent ?? 0,
  );
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function isUsageExpired(usage: AuthAccountUsage, now: number): boolean {
  return usage.windows.some((window) => window.resetAt > 0 && window.resetAt <= now);
}

function isUsageExhausted(usage: AuthAccountUsage): boolean {
  return (
    Math.max(
      findWindow(usage, "primary")?.usedPercent ?? 0,
      findWindow(usage, "secondary")?.usedPercent ?? 0,
    ) >= 99
  );
}

function isUsageUsable(usage: AuthAccountUsage | undefined, now: number): boolean {
  return !usage || isUsageExpired(usage, now) || !isUsageExhausted(usage);
}

function hasActivePrimaryWindow(usage: AuthAccountUsage | undefined, now: number): boolean {
  if (!usage) return false;
  const primary = findWindow(usage, "primary");
  return Boolean(primary && primary.resetAt > now);
}

function updateStoredOAuthAccount(
  authStorage: AuthStorage,
  accountId: string,
  update: (account: CodexAccount) => CodexAccount,
): void {
  authStorage.update((data) => {
    const accounts = ensureProvider(data, PROVIDER_ID).accounts;
    const index = accounts.findIndex(
      (entry) => entry.type === "oauth" && entry.accountId === accountId,
    );
    if (index < 0) return;

    const account = accounts[index];
    if (!account || account.type !== "oauth") return;
    accounts[index] = update(account);
  });
}

function clampPercent(value: unknown): number {
  return typeof value === "number" && !Number.isNaN(value)
    ? Math.min(100, Math.max(0, Math.round(value)))
    : 0;
}

function normalizeNumber(value: unknown): number {
  return typeof value === "number" && !Number.isNaN(value) ? Math.round(value) : 0;
}

function shouldUpdateAccount(current: CodexAccount, updated: OAuthCredentials): boolean {
  const updatedAccountId = normalizeString(updated.accountId);
  const updatedEnterpriseUrl = normalizeString(updated.enterpriseUrl);
  const updatedProjectId = normalizeString(updated.projectId);
  return (
    current.access !== updated.access ||
    current.refresh !== updated.refresh ||
    current.expires !== updated.expires ||
    Boolean(updatedAccountId && updatedAccountId !== current.providerAccountId) ||
    Boolean(updatedEnterpriseUrl && updatedEnterpriseUrl !== current.enterpriseUrl) ||
    Boolean(updatedProjectId && updatedProjectId !== current.projectId)
  );
}

function mergeUpdatedCredentials(account: CodexAccount, updated: OAuthCredentials): CodexAccount {
  return {
    ...account,
    access: updated.access,
    refresh: updated.refresh,
    expires: updated.expires,
    providerAccountId: normalizeString(updated.accountId) ?? account.providerAccountId,
    enterpriseUrl: normalizeString(updated.enterpriseUrl) ?? account.enterpriseUrl,
    projectId: normalizeString(updated.projectId) ?? account.projectId,
  };
}
