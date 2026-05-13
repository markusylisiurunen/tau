import type { OAuthCredentials, OAuthPrompt, OAuthProvider } from "@earendil-works/pi-ai";
import { loginOpenAICodex } from "@earendil-works/pi-ai/oauth";
import { Chalk } from "chalk";
import { CODEX_ORIGINATOR } from "../utils/codex.js";
import { AuthManager } from "./auth_manager.js";
import type { AuthStorage } from "./auth_storage.js";

export type AuthLog = (message: string) => void;
export type AuthPromptFn = (prompt: OAuthPrompt) => Promise<string>;

export type AuthLoginHandler = (callbacks: {
  onAuth: (info: { url: string; instructions?: string }) => void;
  onPrompt: (prompt: OAuthPrompt) => Promise<string>;
  onProgress?: (message: string) => void;
}) => Promise<OAuthCredentials>;

export type OAuthProviderSpec = {
  id: OAuthProvider;
  cliId: string;
  label: string;
};

export const SUPPORTED_OAUTH_PROVIDERS: OAuthProviderSpec[] = [
  { id: "openai-codex", cliId: "codex", label: "OpenAI Codex (ChatGPT Plus/Pro)" },
];

const DEFAULT_LOGIN_HANDLERS: Partial<Record<OAuthProvider, AuthLoginHandler>> = {
  "openai-codex": (callbacks) =>
    loginOpenAICodex({
      onAuth: callbacks.onAuth,
      onPrompt: callbacks.onPrompt,
      onProgress: callbacks.onProgress,
      originator: CODEX_ORIGINATOR,
    }),
};

const chalk = new Chalk({ level: process.stdout.isTTY ? 2 : 0 });
const BAR_WIDTH = 10;

function normalizeProvider(value: string): string {
  return value.trim().toLowerCase();
}

function formatProviderList(providers: OAuthProviderSpec[]): string {
  return providers
    .map((provider, index) => `  ${index + 1}. ${provider.label} (${provider.cliId})`)
    .join("\n");
}

async function promptForProvider(
  prompt: AuthPromptFn,
  log: AuthLog,
  providers: OAuthProviderSpec[],
): Promise<OAuthProvider> {
  log("select a provider:\n");
  log(formatProviderList(providers));
  log("");
  const selection = await prompt({ message: `enter number (1-${providers.length}):` });
  const index = Number.parseInt(selection, 10) - 1;
  if (!Number.isFinite(index) || index < 0 || index >= providers.length) {
    throw new Error("invalid selection.");
  }
  return providers[index]!.id;
}

function resolveProvider(
  providerArg: string | undefined,
  providers: OAuthProviderSpec[],
): OAuthProvider | undefined {
  if (!providerArg) return undefined;
  const normalized = normalizeProvider(providerArg);
  const resolved = providers.find(
    (provider) => provider.id === normalized || provider.cliId === normalized,
  )?.id;
  if (!resolved) {
    const available = providers.map((entry) => entry.cliId).join(", ");
    throw new Error(`unknown provider "${providerArg}". available: ${available}`);
  }
  return resolved;
}

export async function runLoginCommand(options: {
  providerArg?: string;
  authStorage: AuthStorage;
  authPath: string;
  prompt: AuthPromptFn;
  log?: AuthLog;
  providers?: OAuthProviderSpec[];
  loginHandlers?: Partial<Record<OAuthProvider, AuthLoginHandler>>;
}): Promise<void> {
  const log = options.log ?? console.log;
  const providers = options.providers ?? SUPPORTED_OAUTH_PROVIDERS;

  let provider = resolveProvider(options.providerArg, providers);
  if (!provider) {
    provider = await promptForProvider(options.prompt, log, providers);
  }

  const handlers = { ...DEFAULT_LOGIN_HANDLERS, ...options.loginHandlers } as Partial<
    Record<OAuthProvider, AuthLoginHandler>
  >;
  const handler = handlers[provider];

  if (!handler) {
    const available = providers.map((entry) => entry.id).join(", ");
    throw new Error(`unknown provider "${provider}". available: ${available}`);
  }

  log(`logging in to ${provider}...`);

  const credentials = (await handler({
    onAuth: (info) => {
      log("");
      if (provider === "openai-codex") {
        log("copy this url into your browser to complete login:");
      } else {
        log("open this url in your browser:");
      }
      log(info.url);
      if (info.instructions) {
        log(info.instructions);
      }
      if (provider === "openai-codex") {
        log("if the browser callback fails, you'll be prompted to paste the redirect url/code.");
      }
      log("");
    },
    onPrompt: async (prompt) => options.prompt(prompt),
    onProgress: (message) => log(message),
  })) as OAuthCredentials;

  const authManager = new AuthManager(options.authStorage);
  authManager.addOAuthAccount(provider, credentials);
  log(`credentials saved to ${options.authPath}`);
}

export async function runLogoutCommand(options: {
  providerArg?: string;
  accountId?: string;
  authStorage: AuthStorage;
  authPath: string;
  prompt: AuthPromptFn;
  log?: AuthLog;
  providers?: OAuthProviderSpec[];
}): Promise<void> {
  const log = options.log ?? console.log;
  const providers = options.providers ?? SUPPORTED_OAUTH_PROVIDERS;

  let provider = resolveProvider(options.providerArg, providers);
  if (!provider) {
    provider = await promptForProvider(options.prompt, log, providers);
  }

  if (!options.accountId) {
    throw new Error("missing --account <id> for logout");
  }

  const authManager = new AuthManager(options.authStorage);
  authManager.removeAccount(provider, options.accountId);
  log(`removed account ${options.accountId} for ${provider} from ${options.authPath}`);
}

export async function runListCommand(options: {
  authStorage: AuthStorage;
  log?: AuthLog;
}): Promise<void> {
  const log = options.log ?? console.log;
  const authManager = new AuthManager(options.authStorage);
  const providers = await authManager.listProviderAccounts();

  if (providers.length === 0) {
    log("no authenticated accounts found.");
    return;
  }

  for (const [providerIndex, provider] of providers.entries()) {
    if (providerIndex > 0) log("");
    log(`${provider.providerLabel} (${provider.providerId})`);
    const selectedId = provider.selectedAccountId;
    for (const [accountIndex, account] of provider.accounts.entries()) {
      const isSelected = selectedId === account.accountId;
      const marker = isSelected ? chalk.yellow("*") : " ";
      const label = account.email ?? account.accountId;
      const plan = account.plan ? `[${account.plan}]` : undefined;
      const headerSegments = [`  ${marker}`, label, plan].filter(Boolean);
      log(headerSegments.join(" "));
      if (account.usage) {
        for (const window of account.usage.windows) {
          const labelText = formatWindowLabel(window.windowSeconds) ?? window.name;
          const remaining = remainingPercent(window.usedPercent);
          const percentText = `${formatPercent(remaining)}% left`;
          const bar = formatBarRemaining(remaining);
          const reset = formatResetAt(window.resetAt);
          const resetRelative = formatRelativeReset(window.resetAt);
          const resetText = reset
            ? chalk.dim(`resets ${reset}${resetRelative ? ` (${resetRelative})` : ""}`)
            : undefined;
          const lineSegments = [`    ${labelText}`, percentText, bar, resetText].filter(Boolean);
          log(lineSegments.join(" "));
        }
      }
      if (accountIndex < provider.accounts.length - 1) {
        log("");
      }
    }
  }
}

function formatWindowLabel(windowSeconds: number): string | undefined {
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) return undefined;
  if (windowSeconds % 86400 === 0) {
    return `${Math.round(windowSeconds / 86400)}d`;
  }
  if (windowSeconds % 3600 === 0) {
    return `${Math.round(windowSeconds / 3600)}h`;
  }
  if (windowSeconds % 60 === 0) {
    return `${Math.round(windowSeconds / 60)}m`;
  }
  return `${Math.round(windowSeconds)}s`;
}

function formatResetAt(epochSeconds: number): string | undefined {
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return undefined;
  const date = new Date(epochSeconds * 1000);
  if (Number.isNaN(date.getTime())) return undefined;
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${day}.${month}.${year} ${hours}:${minutes}`;
}

function formatRelativeReset(epochSeconds: number): string | undefined {
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return undefined;
  const nowMs = Date.now();
  const deltaMs = epochSeconds * 1000 - nowMs;
  if (!Number.isFinite(deltaMs)) return undefined;
  if (deltaMs <= 0) return "now";

  const totalMinutes = Math.max(1, Math.ceil(deltaMs / 60000));
  const totalHours = Math.floor(totalMinutes / 60);
  const totalDays = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const minutes = totalMinutes % 60;

  const parts: string[] = [];
  if (totalDays > 0) parts.push(`${totalDays}d`);
  if (totalDays > 0 || hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return `in ${parts.join(" ")}`;
}

function formatBarRemaining(remaining: number): string {
  const clamped = clampPercent(remaining);
  const filled = Math.round((clamped / 100) * BAR_WIDTH);
  const empty = Math.max(0, BAR_WIDTH - filled);
  const filledText = "█".repeat(filled);
  const emptyText = "░".repeat(empty);
  if (clamped < 10) {
    const border = chalk.red("▏");
    const rest = chalk.dim("░".repeat(Math.max(0, BAR_WIDTH - 1)));
    return `${border}${rest}`;
  }
  const color = clamped < 50 ? chalk.yellow : chalk.green;
  return `${color(filledText)}${chalk.dim(emptyText)}`;
}

function remainingPercent(usedPercent: number): number {
  const used = Number.isFinite(usedPercent) ? Math.round(usedPercent) : 0;
  const remaining = 100 - used;
  return clampPercent(remaining);
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function formatPercent(value: number): string {
  return String(clampPercent(value)).padStart(3, " ");
}
