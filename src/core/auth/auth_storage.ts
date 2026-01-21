import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AuthStorageData, StoredAccount } from "./types.js";

export class AuthStorage {
  private data: AuthStorageData = { providers: {} };
  private invalidReason: string | undefined;

  constructor(private readonly authPath: string) {
    this.reload();
  }

  reload(): void {
    if (!existsSync(this.authPath)) {
      this.data = { providers: {} };
      this.invalidReason = undefined;
      return;
    }

    try {
      const parsed = JSON.parse(readFileSync(this.authPath, "utf-8")) as unknown;
      const validated = validateAuthStorageData(parsed);
      this.data = validated.data;
      this.invalidReason = validated.invalidReason;
    } catch (error) {
      this.data = { providers: {} };
      this.invalidReason = `failed to parse auth.json: ${(error as Error)?.message ?? String(error)}`;
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

  getData(): AuthStorageData {
    return this.data;
  }

  setData(data: AuthStorageData): void {
    this.data = data;
    this.invalidReason = undefined;
    this.save();
  }

  update(mutator: (data: AuthStorageData) => void): void {
    mutator(this.data);
    this.invalidReason = undefined;
    this.save();
  }

  getInvalidReason(): string | undefined {
    return this.invalidReason;
  }
}

function validateAuthStorageData(value: unknown): {
  data: AuthStorageData;
  invalidReason?: string;
} {
  const invalidReason =
    'auth.json format has changed. please run "tau auth login codex" to re-authenticate.';
  if (!value || typeof value !== "object") {
    return { data: { providers: {} }, invalidReason };
  }
  const providersValue = (value as { providers?: unknown }).providers;
  if (!providersValue || typeof providersValue !== "object" || Array.isArray(providersValue)) {
    return { data: { providers: {} }, invalidReason };
  }
  const providers: AuthStorageData["providers"] = {};
  for (const [key, providerValue] of Object.entries(providersValue as Record<string, unknown>)) {
    if (!providerValue || typeof providerValue !== "object") {
      providers[key] = { accounts: [] };
      continue;
    }
    const accounts = (providerValue as { accounts?: unknown }).accounts;
    if (Array.isArray(accounts)) {
      providers[key] = { accounts: accounts.filter(isStoredAccount) };
    } else {
      providers[key] = { accounts: [] };
    }
  }
  return { data: { providers } };
}

function isStoredAccount(value: unknown): value is StoredAccount {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const type = record.type;
  if (type === "oauth") {
    return (
      typeof record.accountId === "string" &&
      typeof record.access === "string" &&
      typeof record.refresh === "string" &&
      typeof record.expires === "number"
    );
  }
  if (type === "api_key") {
    return typeof record.accountId === "string" && typeof record.key === "string";
  }
  return false;
}
