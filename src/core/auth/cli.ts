import type { OAuthCredentials, OAuthProvider, OAuthPrompt } from "@mariozechner/pi-ai";
import { loginOpenAICodex } from "@mariozechner/pi-ai";
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
  label: string;
};

export const SUPPORTED_OAUTH_PROVIDERS: OAuthProviderSpec[] = [
  { id: "openai-codex", label: "OpenAI Codex (ChatGPT Plus/Pro)" },
];

const DEFAULT_LOGIN_HANDLERS: Partial<Record<OAuthProvider, AuthLoginHandler>> = {
  "openai-codex": (callbacks) =>
    loginOpenAICodex({
      onAuth: callbacks.onAuth,
      onPrompt: callbacks.onPrompt,
      onProgress: callbacks.onProgress,
    }),
};

function normalizeProvider(value: string): string {
  return value.trim().toLowerCase();
}

function formatProviderList(providers: OAuthProviderSpec[]): string {
  return providers.map((provider, index) => `  ${index + 1}. ${provider.label}`).join("\n");
}

async function promptForProvider(
  prompt: AuthPromptFn,
  log: AuthLog,
  providers: OAuthProviderSpec[],
): Promise<OAuthProvider> {
  log("Select a provider:\n");
  log(formatProviderList(providers));
  log("");
  const selection = await prompt({ message: `Enter number (1-${providers.length}):` });
  const index = Number.parseInt(selection, 10) - 1;
  if (!Number.isFinite(index) || index < 0 || index >= providers.length) {
    throw new Error("Invalid selection.");
  }
  return providers[index]!.id;
}

function resolveProvider(
  providerArg: string | undefined,
  providers: OAuthProviderSpec[],
): OAuthProvider | undefined {
  if (!providerArg) return undefined;
  const normalized = normalizeProvider(providerArg);
  return providers.find((provider) => provider.id === normalized)?.id;
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
    throw new Error(`Unknown provider "${provider}". Available: ${available}`);
  }

  log(`Logging in to ${provider}...`);

  const credentials = await handler({
    onAuth: (info) => {
      log("");
      if (provider === "openai-codex") {
        log("Copy this URL into your browser to complete login:");
      } else {
        log("Open this URL in your browser:");
      }
      log(info.url);
      if (info.instructions) {
        log(info.instructions);
      }
      if (provider === "openai-codex") {
        log("If the browser callback fails, you'll be prompted to paste the redirect URL/code.");
      }
      log("");
    },
    onPrompt: async (prompt) => options.prompt(prompt),
    onProgress: (message) => log(message),
  });

  options.authStorage.set(provider, { type: "oauth", ...credentials });
  log(`Credentials saved to ${options.authPath}`);
}

export async function runLogoutCommand(options: {
  providerArg?: string;
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

  options.authStorage.remove(provider);
  log(`Removed credentials for ${provider} from ${options.authPath}`);
}
