import type { OAuthCredential } from "@earendil-works/pi-ai";
import type { AuthStorage } from "./auth_storage.js";
import type { AuthAccountInfo } from "./types.js";

export interface AuthProviderAdapter {
  id: string;
  label: string;
  validateOAuthCredentials?: (credentials: OAuthCredential) => void;
  addOAuthAccount: (authStorage: AuthStorage, credentials: OAuthCredential) => void;
  removeAccount: (authStorage: AuthStorage, accountId: string) => boolean;
  useAccount: (authStorage: AuthStorage, accountId: string) => boolean;
  listAccountInfo: (authStorage: AuthStorage) => Promise<AuthAccountInfo[]>;
}
