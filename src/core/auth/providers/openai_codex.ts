import { createHash } from "node:crypto";
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

type UsageResponse = {
  rate_limit?: {
    primary_window?: {
      used_percent?: number;
      reset_at?: number;
      limit_window_seconds?: number;
    };
    secondary_window?: {
      used_percent?: number;
      reset_at?: number;
      limit_window_seconds?: number;
    };
  };
};

export class OpenAICodexAdapter implements AuthProviderAdapter {
  readonly id = PROVIDER_ID;
  readonly label = PROVIDER_LABEL;

  addOAuthAccount(
    authStorage: AuthStorage,
    credentials: OAuthCredentials & { idToken: string },
  ): void {
    const accountId = resolveAccountId(credentials);
    const providerAccountId = credentials.accountId;
    const account: CodexAccount = {
      type: "oauth",
      accountId,
      providerAccountId,
      access: credentials.access,
      refresh: credentials.refresh,
      expires: credentials.expires,
      idToken: credentials.idToken,
      enterpriseUrl: credentials.enterpriseUrl,
      projectId: credentials.projectId,
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
      const nextAccounts = providerData.accounts.filter((account) => {
        if (account.type !== "oauth") return true;
        if (!matchesIdentifier(account, normalizedId)) return true;
        removed = true;
        return false;
      });
      providerData.accounts = nextAccounts;
    });
    return removed;
  }

  async listAccountInfo(authStorage: AuthStorage): Promise<AuthAccountInfo[]> {
    const accounts = getAccounts(authStorage);
    if (accounts.length === 0) return [];

    const details = await Promise.all(
      accounts.map(async (account) => {
        const identity = decodeIdentity(account.idToken);
        const usage = await this.getUsageSnapshot(authStorage, account, {
          forceRefresh: true,
        });
        return {
          provider: PROVIDER_ID,
          accountId: account.accountId,
          email: identity.email,
          plan: identity.plan,
          usage,
        } satisfies AuthAccountInfo;
      }),
    );

    return details;
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
    const candidates = accounts.map((account, index) => ({
      account,
      index,
      usage: account.usage,
    }));

    const usableCandidates = candidates.filter((candidate) => isUsageUsable(candidate.usage, now));
    if (usableCandidates.length === 0) {
      return undefined;
    }

    usableCandidates.sort((a, b) => compareAccountPriority(a, b, now));

    for (const candidate of usableCandidates) {
      const apiKey = await this.getApiKeyForAccount(authStorage, candidate.account.accountId);
      if (!apiKey) {
        continue;
      }

      let usage = candidate.usage;
      if (shouldRefreshUsage(usage, now)) {
        const refreshed = await this.getUsageSnapshot(authStorage, candidate.account, {
          apiKey,
          refreshIfExpired: true,
          refreshIfMissing: true,
        });
        usage = refreshed ?? usage;
      }

      if (!isUsageUsable(usage, now)) {
        continue;
      }

      return { accountId: candidate.account.accountId, apiKey };
    }

    return undefined;
  }

  selectAccountFromList(accounts: AuthAccountInfo[]): string | undefined {
    if (accounts.length === 0) return undefined;
    const now = nowSeconds();

    const forcedAccountId = getForcedAccountIdFromList(accounts);
    if (forcedAccountId) return forcedAccountId;

    const candidates = accounts.map((account, index) => ({ account, index }));
    const usableCandidates = candidates.filter((candidate) =>
      isUsageUsable(candidate.account.usage, now),
    );
    if (usableCandidates.length === 0) return undefined;
    usableCandidates.sort((a, b) =>
      compareAccountPriority(
        { index: a.index, usage: a.account.usage },
        { index: b.index, usage: b.account.usage },
        now,
      ),
    );
    return usableCandidates[0]?.account.accountId;
  }

  async getApiKeyForAccount(
    authStorage: AuthStorage,
    accountId: string,
  ): Promise<string | undefined> {
    const account = getAccounts(authStorage).find((entry) => entry.accountId === accountId);
    if (!account) return undefined;
    const credential = toOAuthCredentials(account);
    const result = await getOAuthApiKey(PROVIDER_ID as OAuthProvider, {
      [PROVIDER_ID]: credential,
    });
    if (!result) return undefined;
    if (shouldUpdateAccount(account, result.newCredentials)) {
      authStorage.update((data) => {
        const providerData = ensureProvider(data, PROVIDER_ID);
        const index = providerData.accounts.findIndex(
          (entry) => entry.type === "oauth" && entry.accountId === account.accountId,
        );
        if (index < 0) return;
        const current = providerData.accounts[index];
        if (!current || current.type !== "oauth") return;
        providerData.accounts[index] = mergeUpdatedCredentials(current, result.newCredentials);
      });
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
    const now = nowSeconds();
    const usage = await this.getUsageSnapshot(authStorage, account, {
      apiKey: options?.apiKey,
      refreshIfExpired: true,
      refreshIfMissing: true,
    });
    return isUsageUsable(usage, now);
  }

  async handleProviderError(
    authStorage: AuthStorage,
    accountId: string,
    _error: unknown,
  ): Promise<boolean> {
    const account = getAccounts(authStorage).find((entry) => entry.accountId === accountId);
    if (!account) return false;
    const usage = await this.getUsageSnapshot(authStorage, account, {
      forceRefresh: true,
      refreshIfMissing: true,
    });
    if (!usage) return false;
    return isUsageExhausted(usage);
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
    const forceRefresh = options?.forceRefresh ?? false;
    const refreshMissing = options?.refreshIfMissing ?? false;
    const refreshExpired = options?.refreshIfExpired ?? false;
    const shouldRefresh =
      forceRefresh ||
      (refreshMissing && !usage) ||
      (refreshExpired && usage && isUsageExpired(usage, now));

    if (shouldRefresh) {
      try {
        const apiKey =
          options?.apiKey ?? (await this.getApiKeyForAccount(authStorage, account.accountId));
        if (!apiKey) return usage;
        const refreshedAccount =
          getAccounts(authStorage).find((entry) => entry.accountId === account.accountId) ??
          account;
        const refreshed = await fetchUsage(apiKey, refreshedAccount.providerAccountId);
        if (refreshed) {
          usage = refreshed;
          updateAccountUsage(authStorage, account.accountId, refreshed);
        }
      } catch {
        return usage;
      }
    }

    return usage;
  }
}

function ensureProvider(data: AuthStorageData, providerId: string) {
  if (!data.providers[providerId]) {
    data.providers[providerId] = { accounts: [] };
  }
  return data.providers[providerId]!;
}

function getAccounts(authStorage: AuthStorage): CodexAccount[] {
  const data = authStorage.getData();
  const provider = data.providers[PROVIDER_ID];
  if (!provider || !Array.isArray(provider.accounts)) return [];
  return provider.accounts.filter((account): account is CodexAccount => account.type === "oauth");
}

function resolveForcedAccountId(authStorage: AuthStorage): string | undefined {
  const raw = process.env[FORCED_ACCOUNT_ENV];
  if (!raw) return undefined;
  const identifier = normalizeIdentifier(raw);
  if (!identifier) return undefined;
  const account = getAccounts(authStorage).find((entry) => matchesIdentifier(entry, identifier));
  if (!account) {
    throw new Error(
      `${FORCED_ACCOUNT_ENV} did not match any stored Codex account: "${raw}". ` +
        'Run "tau auth list" to see available accounts.',
    );
  }
  return account.accountId;
}

function getForcedAccountIdFromList(accounts: AuthAccountInfo[]): string | undefined {
  const raw = process.env[FORCED_ACCOUNT_ENV];
  if (!raw) return undefined;
  const identifier = normalizeIdentifier(raw);
  if (!identifier) return undefined;
  const account = accounts.find(
    (entry) =>
      entry.email?.trim().toLowerCase() === identifier ||
      entry.accountId.trim().toLowerCase() === identifier,
  );
  return account?.accountId;
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

function resolveAccountId(credentials: OAuthCredentials & { idToken: string }): string {
  if (credentials.accountId) return credentials.accountId;
  const payload = decodeJwtPayload(credentials.idToken);
  const subject = typeof payload?.sub === "string" ? payload.sub.trim() : "";
  if (subject) return subject;
  return createHash("sha256").update(credentials.idToken).digest("hex").slice(0, 16);
}

function decodeIdentity(idToken: string): { email?: string; plan?: string } {
  const payload = decodeJwtPayload(idToken);
  if (!payload) return {};

  const emailValue =
    payload.email ??
    (typeof payload["https://api.openai.com/profile"] === "object"
      ? (payload["https://api.openai.com/profile"] as { email?: unknown }).email
      : undefined);
  const planValue =
    (typeof payload["https://api.openai.com/auth"] === "object"
      ? (payload["https://api.openai.com/auth"] as { chatgpt_plan_type?: unknown })
          .chatgpt_plan_type
      : undefined) ?? payload.chatgpt_plan_type;

  const email = normalizeString(emailValue);
  const plan = normalizeString(planValue);
  return { email, plan };
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

function matchesIdentifier(account: CodexAccount, identifier: string): boolean {
  if (!identifier) return false;
  if (account.accountId.toLowerCase() === identifier) return true;
  const identity = decodeIdentity(account.idToken);
  const email = identity.email ? identity.email.toLowerCase() : undefined;
  return email === identifier;
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
  if (!response.ok) {
    return undefined;
  }
  const data = (await response.json()) as UsageResponse;
  const primary = data.rate_limit?.primary_window;
  const secondary = data.rate_limit?.secondary_window;

  const windows: AuthAccountUsageWindow[] = [];
  if (primary) {
    windows.push({
      name: "primary",
      usedPercent: clampPercent(primary.used_percent),
      resetAt: normalizeNumber(primary.reset_at),
      windowSeconds: normalizeNumber(primary.limit_window_seconds),
    });
  }
  if (secondary) {
    windows.push({
      name: "secondary",
      usedPercent: clampPercent(secondary.used_percent),
      resetAt: normalizeNumber(secondary.reset_at),
      windowSeconds: normalizeNumber(secondary.limit_window_seconds),
    });
  }
  if (windows.length === 0) return undefined;
  return { windows };
}

function compareAccountPriority(
  a: { usage?: AuthAccountUsage; index: number },
  b: { usage?: AuthAccountUsage; index: number },
  now: number,
): number {
  const activeA = hasActivePrimaryWindow(a.usage, now);
  const activeB = hasActivePrimaryWindow(b.usage, now);
  if (activeA !== activeB) return activeA ? -1 : 1;
  return a.index - b.index;
}

function findWindow(usage: AuthAccountUsage, name: string): AuthAccountUsageWindow | undefined {
  return usage.windows.find((window) => window.name === name);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function isUsageExpired(usage: AuthAccountUsage, now: number): boolean {
  return usage.windows.some((window) => window.resetAt > 0 && window.resetAt <= now);
}

function isUsageExhausted(usage: AuthAccountUsage): boolean {
  const primary = findWindow(usage, "primary");
  const secondary = findWindow(usage, "secondary");
  const threshold = 99;
  return (primary?.usedPercent ?? 0) >= threshold || (secondary?.usedPercent ?? 0) >= threshold;
}

function isUsageUsable(usage: AuthAccountUsage | undefined, now: number): boolean {
  if (!usage) return true;
  if (isUsageExpired(usage, now)) return true;
  return !isUsageExhausted(usage);
}

function shouldRefreshUsage(usage: AuthAccountUsage | undefined, now: number): boolean {
  if (!usage) return true;
  return isUsageExpired(usage, now);
}

function hasActivePrimaryWindow(usage: AuthAccountUsage | undefined, now: number): boolean {
  if (!usage) return false;
  const primary = findWindow(usage, "primary");
  return Boolean(primary && primary.resetAt > now);
}

function updateAccountUsage(
  authStorage: AuthStorage,
  accountId: string,
  usage: AuthAccountUsage,
): void {
  authStorage.update((data) => {
    const providerData = ensureProvider(data, PROVIDER_ID);
    const index = providerData.accounts.findIndex(
      (entry) => entry.type === "oauth" && entry.accountId === accountId,
    );
    if (index < 0) return;
    const account = providerData.accounts[index];
    if (!account || account.type !== "oauth") return;
    providerData.accounts[index] = { ...account, usage };
  });
}

function clampPercent(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function normalizeNumber(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  return Math.round(value);
}

function shouldUpdateAccount(current: CodexAccount, updated: OAuthCredentials): boolean {
  return (
    current.access !== updated.access ||
    current.refresh !== updated.refresh ||
    current.expires !== updated.expires ||
    Boolean(updated.accountId && updated.accountId !== current.providerAccountId)
  );
}

function mergeUpdatedCredentials(account: CodexAccount, updated: OAuthCredentials): CodexAccount {
  return {
    ...account,
    access: updated.access,
    refresh: updated.refresh,
    expires: updated.expires,
    providerAccountId: updated.accountId ?? account.providerAccountId,
    enterpriseUrl: updated.enterpriseUrl ?? account.enterpriseUrl,
    projectId: updated.projectId ?? account.projectId,
  };
}
