import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { RemoteModelCatalogSnapshot } from "./remote_catalog.js";

type CatalogState = {
  providers: Map<string, Map<string, Model<Api>>>;
};

export type ModelResolver = (provider: string, modelId: string) => Model<Api> | undefined;

export type LoadedModelResolver = {
  resolveModel: ModelResolver;
  resolveConfiguredModel: ModelResolver;
};

let catalogState: CatalogState | undefined;

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

function createCatalogState(remoteCatalog?: RemoteModelCatalogSnapshot): CatalogState {
  const providers = new Map<string, Map<string, Model<Api>>>();

  for (const provider of getBuiltinProviders()) {
    for (const model of getBuiltinModels(provider)) {
      registerModel({
        providers,
        provider,
        model,
        source: "pi-ai",
      });
    }
  }

  for (const [provider, models] of remoteCatalog ?? []) {
    const providerModels = providers.get(provider);
    if (!providerModels) continue;
    for (const model of models) {
      providerModels.set(model.id, structuredClone(model));
    }
  }

  return { providers };
}

function getCatalogState(): CatalogState {
  if (!catalogState) {
    catalogState = createCatalogState();
  }

  return catalogState;
}

function modelKey(provider: string, modelId: string): string {
  return `${provider}\u0000${modelId}`;
}

function cloneCompat(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }

  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function cloneModel(model: Model<Api>): Model<Api> {
  return {
    ...model,
    input: [...model.input],
    cost: {
      ...model.cost,
      ...(model.cost.tiers ? { tiers: model.cost.tiers.map((tier) => ({ ...tier })) } : {}),
    },
    ...(model.headers ? { headers: { ...model.headers } } : {}),
    ...(model.compat !== undefined
      ? { compat: cloneCompat(model.compat) as Model<Api>["compat"] }
      : {}),
  };
}

function createSyntheticModel(
  provider: string,
  modelId: string,
  providerTemplates: Map<string, Model<Api>>,
): Model<Api> | undefined {
  const template = providerTemplates.get(provider);
  if (!template) {
    return undefined;
  }

  return {
    ...cloneModel(template),
    id: modelId,
    name: modelId,
  };
}

export function loadModelResolver(
  options: { remoteCatalog?: RemoteModelCatalogSnapshot } = {},
): LoadedModelResolver {
  const state = options.remoteCatalog
    ? createCatalogState(options.remoteCatalog)
    : getCatalogState();
  const knownProviders = new Set(state.providers.keys());
  const modelsByKey = new Map<string, Model<Api>>();
  const providerTemplates = new Map<string, Model<Api>>();

  for (const [provider, providerModels] of state.providers.entries()) {
    const models = [...providerModels.values()];
    if (models.length === 0) {
      continue;
    }

    providerTemplates.set(provider, cloneModel(models[0]!));
    for (const model of models) {
      modelsByKey.set(modelKey(provider, model.id), cloneModel(model));
    }
  }

  const resolveConfiguredModel: ModelResolver = (providerRaw, modelIdRaw) => {
    const provider = providerRaw.trim().toLowerCase();
    const modelId = modelIdRaw.trim();
    if (!provider || !modelId || !knownProviders.has(provider)) {
      return undefined;
    }

    const existing = modelsByKey.get(modelKey(provider, modelId));
    if (!existing) {
      return undefined;
    }

    return cloneModel(existing);
  };

  const resolveModel: ModelResolver = (providerRaw, modelIdRaw) => {
    const provider = providerRaw.trim().toLowerCase();
    const modelId = modelIdRaw.trim();
    if (!provider || !modelId || !knownProviders.has(provider)) {
      return undefined;
    }

    const existing = resolveConfiguredModel(provider, modelId);
    if (existing) {
      return existing;
    }

    const synthetic = createSyntheticModel(provider, modelId, providerTemplates);
    if (!synthetic) {
      return undefined;
    }

    return synthetic;
  };

  return {
    resolveModel,
    resolveConfiguredModel,
  };
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
