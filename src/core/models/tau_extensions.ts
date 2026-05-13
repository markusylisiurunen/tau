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
