import type { OAuthCredential } from "@earendil-works/pi-ai";
import type { AuthStorage } from "./auth_storage.js";
import type { AuthAccountInfo } from "./types.js";

export type AuthProviderSelection = {
  accountId: string;
  apiKey: string;
};

export interface AuthProviderAdapter {
  id: string;
  label: string;
  validateOAuthCredentials?: (credentials: OAuthCredential) => void;
  addOAuthAccount: (authStorage: AuthStorage, credentials: OAuthCredential) => void;
  removeAccount: (authStorage: AuthStorage, accountId: string) => boolean;
  setAccountEnabled: (authStorage: AuthStorage, accountId: string, enabled: boolean) => boolean;
  listAccountInfo: (authStorage: AuthStorage) => Promise<AuthAccountInfo[]>;
  selectAccount: (
    authStorage: AuthStorage,
    options?: { signal?: AbortSignal },
  ) => Promise<AuthProviderSelection | undefined>;
  selectAccountFromList?: (accounts: AuthAccountInfo[]) => string | undefined;
  getApiKeyForAccount: (
    authStorage: AuthStorage,
    accountId: string,
    options?: { signal?: AbortSignal },
  ) => Promise<string | undefined>;
  getForcedAccountId?: (authStorage: AuthStorage) => string | undefined;
  isAccountUsable?: (
    authStorage: AuthStorage,
    accountId: string,
    options?: { apiKey?: string; signal?: AbortSignal },
  ) => Promise<boolean>;
  handleProviderError?: (
    authStorage: AuthStorage,
    accountId: string,
    error: unknown,
  ) => Promise<boolean>;
}
