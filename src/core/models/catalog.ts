import type { Api, Model, ModelCostTier } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { z } from "zod";
import type { ConfigDeps } from "../config/deps.js";
import type { ConfigLevel } from "../config/paths.js";
import {
  TAU_PROVIDER_EXTENSIONS,
  type TauProviderApiKeyResolverArgs,
  validateTauProviderExtensionModel,
} from "./tau_extensions.js";

type ApiKeyResolver = (args: TauProviderApiKeyResolverArgs) => string | undefined;

type CatalogState = {
  providers: Map<string, Map<string, Model<Api>>>;
  apiKeyResolvers: Map<string, ApiKeyResolver>;
};

type ModelPatch = {
  api?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  compat?: unknown;
  name?: string;
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    tiers?: ModelCostTier[];
  };
  contextWindow?: number;
  maxTokens?: number;
};

export type ModelResolver = (provider: string, modelId: string) => Model<Api> | undefined;

export type LoadedModelResolver = {
  resolveModel: ModelResolver;
  resolveConfiguredModel: ModelResolver;
  errors: string[];
};

const CostTierSchema = z
  .object({
    inputTokensAbove: z.number().int().nonnegative(),
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cacheRead: z.number().nonnegative(),
    cacheWrite: z.number().nonnegative(),
  })
  .strip();

const CostSchema = z
  .object({
    input: z.number().nonnegative().optional(),
    output: z.number().nonnegative().optional(),
    cacheRead: z.number().nonnegative().optional(),
    cacheWrite: z.number().nonnegative().optional(),
    tiers: z.array(CostTierSchema).optional(),
  })
  .optional();

const ModelSchema = z
  .object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1).optional(),
    api: z.string().trim().min(1).optional(),
    baseUrl: z.string().trim().min(1).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    reasoning: z.boolean().optional(),
    input: z.array(z.enum(["text", "image"])).optional(),
    cost: CostSchema,
    contextWindow: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    compat: z.unknown().optional(),
  })
  .strip();

const ProviderSchema = z
  .object({
    api: z.string().trim().min(1).optional(),
    baseUrl: z.string().trim().min(1).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    compat: z.unknown().optional(),
    models: z.array(ModelSchema).optional(),
  })
  .strip();

const ModelsFileSchema = z
  .object({
    providers: z.record(z.string(), ProviderSchema),
  })
  .strip();

type ParsedModelsFile = z.infer<typeof ModelsFileSchema>;
type ParsedModel = z.infer<typeof ModelSchema>;
type ParsedProvider = z.infer<typeof ProviderSchema>;

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
  onDuplicate?: "error" | "skip";
}): void {
  const providerModels = ensureProviderModels(args.providers, args.provider);
  const existing = providerModels.get(args.model.id);
  if (existing) {
    if (args.onDuplicate === "skip") {
      return;
    }

    throw new Error(
      `duplicate model registration for '${args.provider}:${args.model.id}' from ${args.source}`,
    );
  }

  providerModels.set(args.model.id, args.model);
}

function createCatalogState(): CatalogState {
  registerExtensionApiProvidersOnce();

  const providers = new Map<string, Map<string, Model<Api>>>();

  for (const provider of getBuiltinProviders()) {
    for (const model of getBuiltinModels(provider)) {
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

    validateTauProviderExtensionModel(extension);

    for (const model of extension.models) {
      registerModel({
        providers,
        provider: extension.id,
        model,
        source: `tau extension '${extension.id}'`,
        onDuplicate: "skip",
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeCompat(base: Model<Api>["compat"] | undefined, patch: unknown): Model<Api>["compat"] {
  if (patch === undefined) {
    return base;
  }

  if (isObject(base) && isObject(patch)) {
    return {
      ...base,
      ...patch,
    } as Model<Api>["compat"];
  }

  return patch as Model<Api>["compat"];
}

function applyModelPatch(model: Model<Api>, patch: ModelPatch): Model<Api> {
  let next = cloneModel(model);

  if (patch.api !== undefined) {
    next = { ...next, api: patch.api as Api };
  }

  if (patch.baseUrl !== undefined) {
    next = { ...next, baseUrl: patch.baseUrl };
  }

  if (patch.headers !== undefined) {
    next = {
      ...next,
      headers: {
        ...(next.headers ?? {}),
        ...patch.headers,
      },
    };
  }

  if (patch.compat !== undefined) {
    next = {
      ...next,
      compat: mergeCompat(next.compat, patch.compat),
    };
  }

  if (patch.name !== undefined) {
    next = { ...next, name: patch.name };
  }

  if (patch.reasoning !== undefined) {
    next = { ...next, reasoning: patch.reasoning };
  }

  if (patch.input !== undefined) {
    next = { ...next, input: [...patch.input] };
  }

  if (patch.cost !== undefined) {
    next = {
      ...next,
      cost: {
        ...next.cost,
        ...patch.cost,
      },
    };
  }

  if (patch.contextWindow !== undefined) {
    next = { ...next, contextWindow: patch.contextWindow };
  }

  if (patch.maxTokens !== undefined) {
    next = { ...next, maxTokens: patch.maxTokens };
  }

  return next;
}

function mergeProviderPatch(base: ModelPatch | undefined, overlay: ModelPatch): ModelPatch {
  const mergedHeaders = {
    ...(base?.headers ?? {}),
    ...(overlay.headers ?? {}),
  };

  return {
    ...(base ?? {}),
    ...overlay,
    ...(Object.keys(mergedHeaders).length > 0 ? { headers: mergedHeaders } : {}),
    compat: mergeCompat(base?.compat as Model<Api>["compat"], overlay.compat),
  };
}

function createProviderPatch(provider: ParsedProvider): ModelPatch {
  return {
    ...(provider.api !== undefined ? { api: provider.api } : {}),
    ...(provider.baseUrl !== undefined ? { baseUrl: provider.baseUrl } : {}),
    ...(provider.headers !== undefined ? { headers: provider.headers } : {}),
    ...(provider.compat !== undefined ? { compat: provider.compat } : {}),
  };
}

function createModelPatch(model: ParsedModel): ModelPatch {
  return {
    ...(model.api !== undefined ? { api: model.api } : {}),
    ...(model.baseUrl !== undefined ? { baseUrl: model.baseUrl } : {}),
    ...(model.headers !== undefined ? { headers: model.headers } : {}),
    ...(model.compat !== undefined ? { compat: model.compat } : {}),
    ...(model.name !== undefined ? { name: model.name } : {}),
    ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
    ...(model.input !== undefined ? { input: model.input } : {}),
    ...(model.cost !== undefined ? { cost: model.cost } : {}),
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
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

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return `${path}${issue.message}`;
    })
    .join("; ");
}

function loadModelsFile(
  path: string,
  deps: ConfigDeps,
): { data?: ParsedModelsFile; error?: string } {
  let rawText: string;
  try {
    rawText = deps.fs.readFile(path);
  } catch (error) {
    return {
      error: `${path}: failed to read models file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawText) as unknown;
  } catch (error) {
    return {
      error: `${path}: failed to parse json: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const parsed = ModelsFileSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return {
      error: `${path}: invalid models schema: ${formatZodError(parsed.error)}`,
    };
  }

  return { data: parsed.data };
}

export function loadModelResolver(options: {
  deps: ConfigDeps;
  levels: ConfigLevel[];
}): LoadedModelResolver {
  const deps = options.deps;
  const levels = options.levels;

  const state = getCatalogState();
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

  const providerPatches = new Map<string, ModelPatch>();
  const modelPatches = new Map<string, ModelPatch[]>();
  const errors: string[] = [];

  for (const level of levels) {
    if (!deps.fs.exists(level.modelsPath)) {
      continue;
    }

    const loaded = loadModelsFile(level.modelsPath, deps);
    if (loaded.error) {
      errors.push(loaded.error);
      continue;
    }

    if (!loaded.data) {
      continue;
    }

    for (const [providerNameRaw, providerConfig] of Object.entries(loaded.data.providers)) {
      const providerName = providerNameRaw.trim().toLowerCase();
      if (!providerName || !knownProviders.has(providerName)) {
        errors.push(`${level.modelsPath}: unknown provider '${providerNameRaw}'.`);
        continue;
      }

      const providerPatch = createProviderPatch(providerConfig);
      if (Object.keys(providerPatch).length > 0) {
        providerPatches.set(
          providerName,
          mergeProviderPatch(providerPatches.get(providerName), providerPatch),
        );
      }

      for (const modelConfig of providerConfig.models ?? []) {
        const key = modelKey(providerName, modelConfig.id);
        if (!modelsByKey.has(key)) {
          const synthetic = createSyntheticModel(providerName, modelConfig.id, providerTemplates);
          if (!synthetic) {
            errors.push(
              `${level.modelsPath}: provider '${providerName}' does not have bundled defaults to derive model '${modelConfig.id}'.`,
            );
            continue;
          }
          modelsByKey.set(key, synthetic);
        }

        const patches = modelPatches.get(key) ?? [];
        patches.push(createModelPatch(modelConfig));
        modelPatches.set(key, patches);
      }
    }
  }

  for (const [key, baseModel] of modelsByKey.entries()) {
    const providerPatch = providerPatches.get(baseModel.provider);
    let resolved = providerPatch ? applyModelPatch(baseModel, providerPatch) : baseModel;
    for (const modelPatch of modelPatches.get(key) ?? []) {
      resolved = applyModelPatch(resolved, modelPatch);
    }
    modelsByKey.set(key, resolved);
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

    const providerPatch = providerPatches.get(provider);
    if (!providerPatch) {
      return synthetic;
    }

    return applyModelPatch(synthetic, providerPatch);
  };

  return {
    resolveModel,
    resolveConfiguredModel,
    errors,
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

export function resolveProviderApiKey(args: TauProviderApiKeyResolverArgs): string | undefined {
  const resolver = getCatalogState().apiKeyResolvers.get(args.provider);
  if (!resolver) {
    return undefined;
  }

  return resolver(args);
}
