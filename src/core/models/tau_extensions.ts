import type { Api, Model } from "@earendil-works/pi-ai";

export type TauProviderApiKeyResolverArgs = {
  provider: string;
  apiKeys: Record<string, string> | undefined;
  env: NodeJS.ProcessEnv;
};

export type TauProviderExtension = {
  id: string;
  models: Model<Api>[];
  registerApiProviders?: () => void;
  resolveApiKey?: (args: TauProviderApiKeyResolverArgs) => string | undefined;
};

export const TAU_PROVIDER_EXTENSIONS: TauProviderExtension[] = [];

export function validateTauProviderExtensionModel(extension: TauProviderExtension): void {
  for (const model of extension.models) {
    if (model.provider !== extension.id) {
      throw new Error(
        `invalid model registration for provider '${extension.id}': model '${model.id}' declares provider '${model.provider}'`,
      );
    }
  }
}

export function mergeTauProviderExtensionModels(
  provider: string,
  baseModels: readonly Model<Api>[],
  extensions: readonly TauProviderExtension[] = TAU_PROVIDER_EXTENSIONS,
): Model<Api>[] {
  const modelIds = new Set(baseModels.map((model) => model.id));
  const merged = [...baseModels];

  for (const extension of extensions) {
    if (extension.id !== provider) {
      continue;
    }

    validateTauProviderExtensionModel(extension);

    for (const model of extension.models) {
      if (modelIds.has(model.id)) {
        continue;
      }

      modelIds.add(model.id);
      merged.push(model);
    }
  }

  return merged;
}
