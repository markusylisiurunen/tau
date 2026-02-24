import type { Api, Model } from "@mariozechner/pi-ai";
import { getModels, getProviders } from "@mariozechner/pi-ai";
import { TAU_PROVIDER_EXTENSIONS, type TauProviderApiKeyResolverArgs } from "./tau_extensions.js";

type ApiKeyResolver = (args: TauProviderApiKeyResolverArgs) => string | undefined;

type CatalogState = {
  providers: Map<string, Map<string, Model<Api>>>;
  apiKeyResolvers: Map<string, ApiKeyResolver>;
};

let catalogState: CatalogState | undefined;
let extensionApiProvidersRegistered = false;

function registerExtensionApiProvidersOnce(): void {
  if (extensionApiProvidersRegistered) {
    return;
  }

  for (const extension of TAU_PROVIDER_EXTENSIONS) {
    extension.registerApiProviders?.();
  }
  extensionApiProvidersRegistered = true;
}

function ensureProviderModels(
  providers: Map<string, Map<string, Model<Api>>>,
  provider: string,
): Map<string, Model<Api>> {
  const existing = providers.get(provider);
  if (existing) {
    return existing;
  }

  const created = new Map<string, Model<Api>>();
  providers.set(provider, created);
  return created;
}

function registerModel(args: {
  providers: Map<string, Map<string, Model<Api>>>;
  provider: string;
  model: Model<Api>;
  source: string;
}): void {
  const providerModels = ensureProviderModels(args.providers, args.provider);
  const existing = providerModels.get(args.model.id);
  if (existing) {
    throw new Error(
      `duplicate model registration for '${args.provider}:${args.model.id}' from ${args.source}`,
    );
  }

  providerModels.set(args.model.id, args.model);
}

function createCatalogState(): CatalogState {
  registerExtensionApiProvidersOnce();

  const providers = new Map<string, Map<string, Model<Api>>>();

  for (const provider of getProviders()) {
    for (const model of getModels(provider)) {
      registerModel({ providers, provider, model, source: "pi-ai" });
    }
  }

  const apiKeyResolvers = new Map<string, ApiKeyResolver>();

  for (const extension of TAU_PROVIDER_EXTENSIONS) {
    if (extension.resolveApiKey) {
      if (apiKeyResolvers.has(extension.id)) {
        throw new Error(`duplicate api key resolver registration for provider '${extension.id}'`);
      }
      apiKeyResolvers.set(extension.id, extension.resolveApiKey);
    }

    for (const model of extension.models) {
      if (model.provider !== extension.id) {
        throw new Error(
          `invalid model registration for provider '${extension.id}': model '${model.id}' declares provider '${model.provider}'`,
        );
      }
      registerModel({
        providers,
        provider: extension.id,
        model,
        source: `tau extension '${extension.id}'`,
      });
    }
  }

  return {
    providers,
    apiKeyResolvers,
  };
}

function getCatalogState(): CatalogState {
  if (!catalogState) {
    catalogState = createCatalogState();
  }

  return catalogState;
}

export function listProviders(): string[] {
  return [...getCatalogState().providers.keys()];
}

export function listModels(provider: string): Model<Api>[] {
  const providerModels = getCatalogState().providers.get(provider);
  return providerModels ? [...providerModels.values()] : [];
}

export function resolveModel(provider: string, modelId: string): Model<Api> | undefined {
  return getCatalogState().providers.get(provider)?.get(modelId);
}

export function resolveModelOrThrow(provider: string, modelId: string): Model<Api> {
  const model = resolveModel(provider, modelId);
  if (!model) {
    throw new Error(`failed to resolve model '${provider}:${modelId}'`);
  }

  return model;
}

export function resolveProviderApiKey(args: TauProviderApiKeyResolverArgs): string | undefined {
  const resolver = getCatalogState().apiKeyResolvers.get(args.provider);
  if (!resolver) {
    return undefined;
  }

  return resolver(args);
}
