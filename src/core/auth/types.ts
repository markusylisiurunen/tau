export type StoredApiKeyAccount = {
  type: "api_key";
  accountId: string;
  key: string;
};

export type StoredOAuthAccount = {
  type: "oauth";
  accountId: string;
  providerAccountId?: string;
  access: string;
  refresh: string;
  expires: number;
  idToken: string;
  enterpriseUrl?: string;
  projectId?: string;
  usage?: AuthAccountUsage;
};

export type StoredAccount = StoredApiKeyAccount | StoredOAuthAccount;

export type ProviderAuthData = {
  accounts: StoredAccount[];
};

export type AuthStorageData = {
  providers: Record<string, ProviderAuthData>;
};

export type AuthAccountUsageWindow = {
  name: string;
  usedPercent: number;
  resetAt: number;
  windowSeconds: number;
};

export type AuthAccountUsage = {
  windows: AuthAccountUsageWindow[];
};

export type AuthAccountInfo = {
  provider: string;
  accountId: string;
  email?: string;
  plan?: string;
  usage?: AuthAccountUsage;
};
