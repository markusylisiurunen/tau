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
    if (!key.trim()) {
      return { data: { providers: {} }, invalidReason };
    }

    if (!providerValue || typeof providerValue !== "object" || Array.isArray(providerValue)) {
      return { data: { providers: {} }, invalidReason };
    }

    const accountsValue = (providerValue as { accounts?: unknown }).accounts;
    if (!Array.isArray(accountsValue)) {
      return { data: { providers: {} }, invalidReason };
    }

    const accounts: StoredAccount[] = [];
    for (const account of accountsValue) {
      if (!isStoredAccount(account)) {
        return { data: { providers: {} }, invalidReason };
      }
      accounts.push(account);
    }

    providers[key] = { accounts };
  }

  return { data: { providers } };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isAuthAccountUsageWindow(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  const record = value as Record<string, unknown>;
  return (
    isNonEmptyString(record.name) &&
    typeof record.usedPercent === "number" &&
    Number.isFinite(record.usedPercent) &&
    typeof record.resetAt === "number" &&
    Number.isFinite(record.resetAt) &&
    typeof record.windowSeconds === "number" &&
    Number.isFinite(record.windowSeconds)
  );
}

function isAuthAccountUsage(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  const windows = (value as { windows?: unknown }).windows;
  return Array.isArray(windows) && windows.every(isAuthAccountUsageWindow);
}

function isStoredAccount(value: unknown): value is StoredAccount {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  const record = value as Record<string, unknown>;
  const type = record.type;

  if (type === "oauth") {
    const providerAccountId = record.providerAccountId;
    const enterpriseUrl = record.enterpriseUrl;
    const projectId = record.projectId;
    const usage = record.usage;

    return (
      isNonEmptyString(record.accountId) &&
      isNonEmptyString(record.access) &&
      isNonEmptyString(record.refresh) &&
      typeof record.expires === "number" &&
      Number.isFinite(record.expires) &&
      (providerAccountId === undefined || isNonEmptyString(providerAccountId)) &&
      (enterpriseUrl === undefined || isNonEmptyString(enterpriseUrl)) &&
      (projectId === undefined || isNonEmptyString(projectId)) &&
      (usage === undefined || isAuthAccountUsage(usage))
    );
  }

  if (type === "api_key") {
    return isNonEmptyString(record.accountId) && isNonEmptyString(record.key);
  }

  return false;
}
