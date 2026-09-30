import type { OAuthCredential } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { AuthStorage } from "../auth_storage.js";
import { decodeJwtPayload } from "../jwt.js";
import type { AuthProviderAdapter } from "../provider_adapter.js";
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
const ALLOWED_USAGE_WINDOW_SECONDS = new Set([5 * 60 * 60, 7 * 24 * 60 * 60]);
const openaiCodexOAuth = getOpenAICodexOAuth();

function getOpenAICodexOAuth() {
  const oauth = openaiCodexProvider().auth.oauth;
  if (!oauth) {
    throw new Error("OpenAI Codex provider is missing OAuth support");
  }
  return oauth;
}

class UnexpectedUsageWindowError extends Error {
  constructor(name: "primary" | "secondary", windowSeconds: number) {
    super(
      `unexpected ChatGPT Codex ${name} usage window: ${windowSeconds} seconds ` +
        "(expected 18000 for 5h or 604800 for 7d)",
    );
  }
}

type CodexAccount = StoredOAuthAccount;
type UnknownRecord = Record<string, unknown>;
type RefreshStatus = "not-requested" | "succeeded" | "failed";
type AccountRefreshResult = {
  account: CodexAccount;
  refreshStatus: Exclude<RefreshStatus, "not-requested">;
};
type UsageSnapshotResult = {
  usage?: AuthAccountUsage;
  refreshStatus: RefreshStatus;
};

export class OpenAICodexAdapter implements AuthProviderAdapter {
  readonly id = PROVIDER_ID;
  readonly label = PROVIDER_LABEL;

  validateOAuthCredentials(credentials: OAuthCredential): void {
    assertCodexClaims(credentials);
  }

  addOAuthAccount(authStorage: AuthStorage, credentials: OAuthCredential): void {
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
      const isFirstAccount = providerData.accounts.length === 0;
      const existingIndex = providerData.accounts.findIndex(
        (entry) => entry.type === "oauth" && entry.accountId === accountId,
      );
      if (existingIndex >= 0) {
        providerData.accounts[existingIndex] = {
          ...account,
        };
      } else {
        providerData.accounts.push(account);
        if (isFirstAccount) providerData.activeAccountId = accountId;
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
        if (providerData.activeAccountId === account.accountId) providerData.activeAccountId = null;
        removed = true;
        return false;
      });
    });
    return removed;
  }

  useAccount(authStorage: AuthStorage, accountId: string): boolean {
    const normalizedId = normalizeIdentifier(accountId);
    return authStorage.update((data) => {
      const provider = ensureProvider(data, PROVIDER_ID);
      const account = provider.accounts.find(
        (entry) => entry.type === "oauth" && matchesIdentifier(entry, normalizedId),
      );
      if (!account) return false;
      provider.activeAccountId = account.accountId;
      return true;
    });
  }

  async listAccountInfo(authStorage: AuthStorage): Promise<AuthAccountInfo[]> {
    const accounts = getAccounts(authStorage);
    if (accounts.length === 0) return [];

    const accountInfo = await Promise.all(
      accounts.map(async (account): Promise<AuthAccountInfo | undefined> => {
        const accountRefresh = await this.refreshAccountIdentity(authStorage, account);
        if (!accountRefresh) {
          return undefined;
        }
        const usageSnapshot = await this.getUsageSnapshot(authStorage, accountRefresh.account, {
          forceRefresh: true,
        });
        const currentAccount = getAccounts(authStorage).find(
          (entry) => entry.accountId === account.accountId,
        );
        if (!currentAccount) {
          return undefined;
        }
        const identity = decodeIdentity(currentAccount.access);
        const credentialRefreshStatus =
          accountRefresh.refreshStatus === "succeeded" ||
          !hasSameCredentialGeneration(currentAccount, accountRefresh.account)
            ? "succeeded"
            : "failed";
        return {
          provider: PROVIDER_ID,
          accountId: currentAccount.accountId,
          email: identity.email,
          plan: identity.plan,
          credentialExpired: Date.now() >= currentAccount.expires,
          credentialRefreshStatus,
          usage: usageSnapshot.usage,
          usageRefreshStatus: usageSnapshot.refreshStatus === "succeeded" ? "succeeded" : "failed",
        } satisfies AuthAccountInfo;
      }),
    );
    return accountInfo.filter((account): account is AuthAccountInfo => account !== undefined);
  }

  private async getApiKeyForAccount(
    authStorage: AuthStorage,
    accountId: string,
    options?: { signal?: AbortSignal },
  ): Promise<string | undefined> {
    return await authStorage.withAccountLock(
      PROVIDER_ID,
      accountId,
      async () => {
        options?.signal?.throwIfAborted();
        authStorage.reload();
        const account = getAccounts(authStorage).find((entry) => entry.accountId === accountId);
        if (!account) return undefined;

        let credential = toOAuthCredential(account);
        if (Date.now() >= credential.expires) {
          credential = await openaiCodexOAuth.refresh(
            credential,
            options?.signal ?? new AbortController().signal,
          );
          options?.signal?.throwIfAborted();
        }

        const updateResult = updateStoredOAuthAccount(authStorage, account, (current) =>
          shouldUpdateAccount(current, credential)
            ? mergeUpdatedCredentials(current, credential)
            : current,
        );
        if (updateResult.status !== "updated") {
          return undefined;
        }

        const apiKey = (await openaiCodexOAuth.toAuth(toOAuthCredential(updateResult.account)))
          .apiKey;
        options?.signal?.throwIfAborted();
        return apiKey;
      },
      options?.signal,
    );
  }

  private async refreshAccountIdentity(
    authStorage: AuthStorage,
    account: CodexAccount,
  ): Promise<AccountRefreshResult | undefined> {
    try {
      return await authStorage.withAccountLock(PROVIDER_ID, account.accountId, async () => {
        authStorage.reload();
        const currentAccount = getAccounts(authStorage).find(
          (entry) => entry.accountId === account.accountId,
        );
        if (!currentAccount) return undefined;
        const refreshedCredentials = await openaiCodexOAuth.refresh(
          toOAuthCredential(currentAccount),
          new AbortController().signal,
        );
        const updateResult = updateStoredOAuthAccount(authStorage, currentAccount, (current) =>
          shouldUpdateAccount(current, refreshedCredentials)
            ? mergeUpdatedCredentials(current, refreshedCredentials)
            : current,
        );
        return updateResult.status === "missing"
          ? undefined
          : { account: updateResult.account, refreshStatus: "succeeded" };
      });
    } catch {
      authStorage.reload();
      const currentAccount = getAccounts(authStorage).find(
        (entry) => entry.accountId === account.accountId,
      );
      return currentAccount
        ? {
            account: currentAccount,
            refreshStatus: hasSameCredentialGeneration(currentAccount, account)
              ? "failed"
              : "succeeded",
          }
        : undefined;
    }
  }

  private async getUsageSnapshot(
    authStorage: AuthStorage,
    account: CodexAccount,
    options?: {
      apiKey?: string;
      forceRefresh?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<UsageSnapshotResult> {
    options?.signal?.throwIfAborted();
    const usage = account.usage;
    const shouldRefresh = Boolean(options?.forceRefresh);
    if (!shouldRefresh) return { usage, refreshStatus: "not-requested" };

    try {
      const apiKey =
        options?.apiKey ??
        (await this.getApiKeyForAccount(authStorage, account.accountId, {
          signal: options?.signal,
        }));
      if (!apiKey) return { usage, refreshStatus: "failed" };

      const refreshedAccount =
        getAccounts(authStorage).find((entry) => entry.accountId === account.accountId) ?? account;
      const refreshedUsage = await fetchUsage(
        apiKey,
        refreshedAccount.providerAccountId,
        options?.signal,
      );
      options?.signal?.throwIfAborted();
      if (!refreshedUsage) return { usage, refreshStatus: "failed" };

      const updateResult = updateStoredOAuthAccount(authStorage, refreshedAccount, (current) => ({
        ...current,
        usage: refreshedUsage,
      }));
      if (updateResult.status === "missing") {
        return { refreshStatus: "failed" };
      }
      return {
        usage: updateResult.status === "changed" ? updateResult.account.usage : refreshedUsage,
        refreshStatus: updateResult.status === "changed" ? "failed" : "succeeded",
      };
    } catch (error) {
      options?.signal?.throwIfAborted();
      if (error instanceof UnexpectedUsageWindowError) {
        throw error;
      }
      return { usage, refreshStatus: "failed" };
    }
  }
}

function ensureProvider(data: AuthStorageData, providerId: string) {
  if (!data.providers[providerId]) {
    data.providers[providerId] = { accounts: [], activeAccountId: null };
  }
  return data.providers[providerId]!;
}

function getAccounts(authStorage: AuthStorage): CodexAccount[] {
  const provider = authStorage.getData().providers[PROVIDER_ID];
  if (!provider) return [];
  return provider.accounts.filter((account): account is CodexAccount => account.type === "oauth");
}

function toOAuthCredential(account: CodexAccount): OAuthCredential {
  const credential: OAuthCredential = {
    type: "oauth",
    refresh: account.refresh,
    access: account.access,
    expires: account.expires,
    enterpriseUrl: account.enterpriseUrl,
    projectId: account.projectId,
  };
  if (account.providerAccountId) {
    credential.accountId = account.providerAccountId;
  }
  return credential;
}

function assertCodexClaims(credentials: OAuthCredential): {
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
  signal?: AbortSignal,
): Promise<AuthAccountUsage | undefined> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
  if (providerAccountId) {
    headers["ChatGPT-Account-Id"] = providerAccountId;
  }

  const response = await fetch(USAGE_ENDPOINT, { method: "GET", headers, signal });
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

  const windowSeconds = normalizeNumber(window.limit_window_seconds);
  if (!ALLOWED_USAGE_WINDOW_SECONDS.has(windowSeconds)) {
    throw new UnexpectedUsageWindowError(name, windowSeconds);
  }

  return {
    name,
    usedPercent: clampPercent(window.used_percent),
    resetAt: normalizeNumber(window.reset_at),
    windowSeconds,
  };
}

type StoredOAuthAccountUpdateResult =
  | { status: "missing" }
  | { status: "changed"; account: CodexAccount }
  | { status: "updated"; account: CodexAccount };

function updateStoredOAuthAccount(
  authStorage: AuthStorage,
  expected: CodexAccount,
  update: (account: CodexAccount) => CodexAccount,
): StoredOAuthAccountUpdateResult {
  return authStorage.update((data): StoredOAuthAccountUpdateResult => {
    const accounts = ensureProvider(data, PROVIDER_ID).accounts;
    const index = accounts.findIndex(
      (entry) => entry.type === "oauth" && entry.accountId === expected.accountId,
    );
    if (index < 0) return { status: "missing" };

    const account = accounts[index];
    if (account?.type !== "oauth") return { status: "missing" };
    if (!hasSameCredentialGeneration(account, expected)) {
      return { status: "changed", account };
    }

    const updated = update(account);
    accounts[index] = updated;
    return { status: "updated", account: updated };
  });
}

function hasSameCredentialGeneration(a: CodexAccount, b: CodexAccount): boolean {
  return (
    a.accountId === b.accountId &&
    a.providerAccountId === b.providerAccountId &&
    a.access === b.access &&
    a.refresh === b.refresh &&
    a.expires === b.expires &&
    a.enterpriseUrl === b.enterpriseUrl &&
    a.projectId === b.projectId
  );
}

function clampPercent(value: unknown): number {
  return typeof value === "number" && !Number.isNaN(value)
    ? Math.min(100, Math.max(0, Math.round(value)))
    : 0;
}

function normalizeNumber(value: unknown): number {
  return typeof value === "number" && !Number.isNaN(value) ? Math.round(value) : 0;
}

function shouldUpdateAccount(current: CodexAccount, updated: OAuthCredential): boolean {
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

function mergeUpdatedCredentials(account: CodexAccount, updated: OAuthCredential): CodexAccount {
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
