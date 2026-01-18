import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getOAuthApiKey, type OAuthCredentials, type OAuthProvider } from "@mariozechner/pi-ai";

export type ApiKeyCredential = {
  type: "api_key";
  key: string;
};

export type OAuthCredential = {
  type: "oauth";
} & OAuthCredentials;

export type AuthCredential = ApiKeyCredential | OAuthCredential;

export type AuthStorageData = Record<string, AuthCredential>;

export class AuthStorage {
  private data: AuthStorageData = {};
  private refreshLocks = new Map<string, Promise<string | undefined>>();

  constructor(private readonly authPath: string) {
    this.reload();
  }

  reload(): void {
    if (!existsSync(this.authPath)) {
      this.data = {};
      return;
    }

    try {
      const parsed = JSON.parse(readFileSync(this.authPath, "utf-8")) as AuthStorageData;
      this.data = parsed ?? {};
    } catch {
      this.data = {};
    }
  }

  private save(): void {
    const dir = dirname(this.authPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    const tmpPath = `${this.authPath}.${randomUUID()}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmpPath, this.authPath);
    chmodSync(this.authPath, 0o600);
  }

  get(provider: string): AuthCredential | undefined {
    return this.data[provider] ?? undefined;
  }

  set(provider: string, credential: AuthCredential): void {
    this.data[provider] = credential;
    this.save();
  }

  remove(provider: string): void {
    delete this.data[provider];
    this.save();
  }

  list(): string[] {
    return Object.keys(this.data);
  }

  hasAuth(provider: string): boolean {
    return provider in this.data;
  }

  async getApiKey(provider: string): Promise<string | undefined> {
    return this.withRefreshLock(provider, async () => {
      this.reload();

      const credential = this.data[provider];
      if (!credential) {
        return undefined;
      }

      if (credential.type === "api_key") {
        return credential.key;
      }

      const oauthCredentials: Record<string, OAuthCredentials> = {};
      for (const [key, value] of Object.entries(this.data)) {
        if (value.type === "oauth") {
          oauthCredentials[key] = value;
        }
      }

      const result = await getOAuthApiKey(provider as OAuthProvider, oauthCredentials);
      if (!result) {
        return undefined;
      }

      this.data[provider] = { type: "oauth", ...result.newCredentials };
      this.save();

      return result.apiKey;
    });
  }

  private async withRefreshLock(
    provider: string,
    action: () => Promise<string | undefined>,
  ): Promise<string | undefined> {
    const existing = this.refreshLocks.get(provider);
    if (existing) {
      return existing;
    }

    const inFlight = action().finally(() => {
      this.refreshLocks.delete(provider);
    });
    this.refreshLocks.set(provider, inFlight);
    return inFlight;
  }
}
