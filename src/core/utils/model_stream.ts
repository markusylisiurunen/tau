import type {
  Api,
  ApiStreamOptions,
  AssistantMessageEventStream,
  AuthContext,
  AuthResult,
  Context,
  Model,
  MutableModels,
  Provider,
  ProviderStreamOptions,
  SimpleStreamOptions,
  ThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  createModels,
  defaultProviderAuthContext,
  getSupportedThinkingLevels,
  lazyStream,
  normalizeContext,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { formatCodexAuthError } from "../auth/auth_messages.js";
import type { AuthStorage } from "../auth/auth_storage.js";
import { TauCredentialStore } from "../auth/credential_store.js";
import type { Config } from "../config/schema.js";
import type { ReasoningEffort, ServiceTier } from "../types.js";
import type { TauStreamOptions } from "./streaming_settings.js";

type BedrockStreamOptions = ProviderStreamOptions & {
  reasoning?: ThinkingLevel;
  thinkingBudgets?: TauStreamOptions["thinkingBudgets"];
  interleavedThinking?: boolean;
};

type OpenAIResponsesStreamOptions = ProviderStreamOptions & {
  reasoningEffort?: ReasoningEffort;
  serviceTier?: ServiceTier;
};

type ModelRuntimeOptions = {
  authStorage?: AuthStorage;
  getConfig?: () => Config;
  authPath?: string;
  env?: NodeJS.ProcessEnv;
};

const registeredRuntimeProviders = new Map<string, Provider>();

function createModelAuthContext(env: NodeJS.ProcessEnv): AuthContext {
  const base = defaultProviderAuthContext();
  return {
    env: async (name) => {
      const value = env[name];
      return typeof value === "string" && value.trim().length > 0 ? value : undefined;
    },
    fileExists: (path) => base.fileExists(path),
  };
}

function formatModelCodexAuthError(authPath: string | undefined, detail?: string): string {
  if (authPath) {
    return formatCodexAuthError(authPath, detail);
  }

  const base =
    'no active OpenAI Codex credentials; run "tau auth login codex" or "tau auth use codex --account <email-or-id>".';
  return detail ? `${base} ${detail}` : base;
}

export class ModelRuntime {
  readonly models: MutableModels;
  private readonly authPath?: string;
  private readonly credentialStore?: TauCredentialStore;

  constructor(options: ModelRuntimeOptions = {}) {
    this.authPath = options.authPath;
    this.credentialStore =
      options.authStorage && options.getConfig
        ? new TauCredentialStore({
            authStorage: options.authStorage,
            getConfig: options.getConfig,
            env: options.env,
          })
        : undefined;
    this.models = builtinModels({
      ...(this.credentialStore ? { credentials: this.credentialStore } : {}),
      ...(options.env ? { authContext: createModelAuthContext(options.env) } : {}),
    });

    for (const provider of registeredRuntimeProviders.values()) {
      this.models.setProvider(provider);
    }
  }

  resolveModel(provider: string, modelId: string): Model<Api> | undefined {
    return this.models.getModel(provider, modelId);
  }

  async getAuth(model: Model<Api>, signal?: AbortSignal): Promise<AuthResult | undefined> {
    signal?.throwIfAborted();
    const models = isOpenAICodexModel(model) ? this.createCodexRequestModels() : this.models;
    const pending = models.getAuth(model, { signal });
    if (!signal) return await pending;
    return await new Promise<AuthResult | undefined>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      pending.then(
        (auth) => {
          signal.removeEventListener("abort", onAbort);
          resolve(auth);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  streamModel<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options: TauStreamOptions,
  ): AssistantMessageEventStream {
    if (isOpenAICodexModel(model)) {
      return lazyStream(model, async () => {
        let auth: AuthResult | undefined;
        try {
          auth = await this.getAuth(model, options.signal);
        } catch (error) {
          options.signal?.throwIfAborted();
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(formatModelCodexAuthError(this.authPath, detail));
        }
        options.signal?.throwIfAborted();
        if (!auth) throw new Error(formatModelCodexAuthError(this.authPath));
        const provider = this.models.getProvider(model.provider);
        if (!provider) throw new Error(`missing model provider '${model.provider}'`);
        const requestModel = auth.auth.baseUrl ? { ...model, baseUrl: auth.auth.baseUrl } : model;
        const headers = { ...auth.auth.headers };
        for (const [name, value] of Object.entries(options.headers ?? {})) {
          for (const existingName of Object.keys(headers)) {
            if (existingName.toLowerCase() === name.toLowerCase()) delete headers[existingName];
          }
          headers[name] = value;
        }
        return provider.stream<"openai-codex-responses">(
          requestModel as Model<"openai-codex-responses">,
          normalizeContext(context),
          {
            ...resolveOpenAIResponsesOptions(model, options),
            apiKey: auth.auth.apiKey,
            headers,
            ...(auth.env ? { env: { ...auth.env, ...options.env } } : {}),
          } as ApiStreamOptions<"openai-codex-responses">,
        );
      });
    }
    return this.streamModelWithOptions(model, context, options);
  }

  private createCodexRequestModels(): MutableModels {
    const provider = this.models.getProvider("openai-codex");
    if (!provider) throw new Error("missing Codex provider");
    const models = createModels({ credentials: this.credentialStore?.bindCodexAccount() });
    models.setProvider(provider);
    return models;
  }

  private streamModelWithOptions<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options: TauStreamOptions,
  ): AssistantMessageEventStream {
    if (isBedrockModel(model)) {
      const providerOptions = resolveBedrockOptions(model, options);
      return this.models.stream<"bedrock-converse-stream">(
        model,
        context,
        providerOptions as ApiStreamOptions<"bedrock-converse-stream">,
      );
    }

    if (isOpenAIResponsesModel(model)) {
      return this.models.stream<"openai-responses">(
        model,
        context,
        resolveOpenAIResponsesOptions(model, options) as ApiStreamOptions<"openai-responses">,
      );
    }

    return this.models.streamSimple(model, context, resolveSimpleStreamOptions(options));
  }
}

export function registerModelRuntimeProvider(provider: Provider): () => void {
  const previousProvider = registeredRuntimeProviders.get(provider.id);
  registeredRuntimeProviders.set(provider.id, provider);
  return () => {
    if (previousProvider) {
      registeredRuntimeProviders.set(provider.id, previousProvider);
      return;
    }

    registeredRuntimeProviders.delete(provider.id);
  };
}

function normalizeSimpleReasoning(
  reasoning: TauStreamOptions["reasoning"],
): ThinkingLevel | undefined {
  if (reasoning === undefined || reasoning === "none") {
    return undefined;
  }

  return reasoning;
}

export function resolveSimpleStreamOptions(options: TauStreamOptions): SimpleStreamOptions {
  const { reasoning, ...baseOptions } = options;
  const normalizedReasoning = normalizeSimpleReasoning(reasoning);

  if (normalizedReasoning === undefined) {
    return baseOptions;
  }

  return {
    ...baseOptions,
    reasoning: normalizedReasoning,
  };
}

function isBedrockModel(model: Model<Api>): model is Model<"bedrock-converse-stream"> {
  return model.api === "bedrock-converse-stream" || model.provider === "amazon-bedrock";
}

function isBedrockAnthropicModel(model: Model<Api>): boolean {
  return isBedrockModel(model) && model.id.includes("anthropic.");
}

function isOpenAIResponsesModel(model: Model<Api>): model is Model<"openai-responses"> {
  return model.api === "openai-responses" && model.provider === "openai";
}

function isOpenAICodexModel(model: Model<Api>): model is Model<"openai-codex-responses"> {
  return model.api === "openai-codex-responses" && model.provider === "openai-codex";
}

function resolveBedrockOptions(
  model: Model<"bedrock-converse-stream">,
  options: TauStreamOptions,
): BedrockStreamOptions {
  const { reasoning, ...baseOptions } = options;
  const normalizedReasoning = normalizeSimpleReasoning(reasoning);

  return {
    ...baseOptions,
    ...(normalizedReasoning !== undefined ? { reasoning: normalizedReasoning } : {}),
    maxTokens: options.maxTokens || Math.min(model.maxTokens, 32000),
    ...(isBedrockAnthropicModel(model) ? { interleavedThinking: true } : {}),
  };
}

export function resolveOpenAIReasoningEffort(
  model: Model<"openai-responses"> | Model<"openai-codex-responses">,
  reasoning: TauStreamOptions["reasoning"],
): ReasoningEffort | undefined {
  if (reasoning === undefined) {
    return undefined;
  }

  if (reasoning === "none") {
    return reasoning;
  }

  if (
    (reasoning !== "xhigh" && reasoning !== "max") ||
    getSupportedThinkingLevels(model).includes(reasoning)
  ) {
    return reasoning;
  }

  return "high";
}

export function resolveOpenAIResponsesOptions(
  model: Model<"openai-responses"> | Model<"openai-codex-responses">,
  options: TauStreamOptions,
): OpenAIResponsesStreamOptions {
  const reasoningEffort = resolveOpenAIReasoningEffort(model, options.reasoning);
  const { reasoning: _reasoning, serviceTier: _serviceTier, ...baseOptions } = options;

  return {
    ...baseOptions,
    ...(isOpenAICodexModel(model) && options.transport === undefined
      ? { transport: "websocket-cached" as const }
      : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(options.serviceTier !== undefined ? { serviceTier: options.serviceTier } : {}),
  } satisfies OpenAIResponsesStreamOptions;
}
