import type { OAuthCredentials } from "@mariozechner/pi-ai";
import type { AuthStorage } from "./auth_storage.js";
import type { AuthAccountInfo } from "./types.js";

export type AuthProviderSelection = {
  accountId: string;
  apiKey: string;
};

export interface AuthProviderAdapter {
  id: string;
  label: string;
  addOAuthAccount: (
    authStorage: AuthStorage,
    credentials: OAuthCredentials & { idToken: string },
  ) => void;
  removeAccount: (authStorage: AuthStorage, accountId: string) => boolean;
  listAccountInfo: (authStorage: AuthStorage) => Promise<AuthAccountInfo[]>;
  selectAccount: (authStorage: AuthStorage) => Promise<AuthProviderSelection | undefined>;
  selectAccountFromList?: (accounts: AuthAccountInfo[]) => string | undefined;
  getApiKeyForAccount: (authStorage: AuthStorage, accountId: string) => Promise<string | undefined>;
  getForcedAccountId?: (authStorage: AuthStorage) => string | undefined;
  isAccountUsable?: (
    authStorage: AuthStorage,
    accountId: string,
    options?: { apiKey?: string },
  ) => Promise<boolean>;
  handleProviderError?: (
    authStorage: AuthStorage,
    accountId: string,
    error: unknown,
  ) => Promise<boolean>;
}
