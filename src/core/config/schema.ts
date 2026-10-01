import { z } from "zod";
import {
  type LoadedModelResolver,
  listProviders,
  loadModelResolver,
  type ModelResolver,
} from "../models/catalog.js";
import { normalizeNookDomain } from "../nook/validation.js";
import { formatPersonaReference, parsePersonaReference } from "../persona_reference.js";
import { parseSubagentLaunchModelList } from "../subagents/launch_model.js";
import { REASONING_LEVELS } from "../types.js";
import { normalizeModelNoticeKey, parseModelNoticeKey } from "../utils/model_notices.js";
import type { CommandClientToolConfig } from "./client_tools.js";
import {
  parseCommandClientToolsConfig,
  parseEnabledClientToolsConfig,
  resolveCommandClientToolsConfig,
  selectCommandClientTools,
} from "./client_tools.js";
import type { ConfigDeps } from "./deps.js";
import { type McpServersConfig, parseMcpServersConfig, resolveMcpServersConfig } from "./mcp.js";
import type { ConfigLevel } from "./paths.js";
import { resolveConfigLevels } from "./paths.js";
import { getVirtualConfigDefaults } from "./virtual_defaults.js";

export interface Config {
  apiKeys?: Record<string, string>;
  speech?: { voiceId?: string; recordingShortcut?: RecordingShortcut };
  defaultPersona?: string;
  defaultTheme?: string;
  clientTools?: CommandClientToolConfig[];
  enabledClientTools?: string[];
  subagents?: {
    launchModels?: string[];
  };
  modelSystemNotices?: Record<string, string>;
  flySprites?: FlySpritesConfig;
  nook?: NookConfig;
  history?: HistoryConfig;
  mcpServers?: McpServersConfig;
}

export type RecordingShortcut = {
  key: string;
  gesture: "press" | "double-tap";
};

export type FlySpritesConfig = {
  baseURL?: string;
  token?: string;
  tokenEnv?: string;
  home?: string;
};

export type NookConfig = {
  domain: string;
  accessClientId?: string;
  accessClientSecret?: string;
  accessClientSecretEnv?: string;
};

export type HistoryConfig = {
  endpoint: string;
  apiKey?: string;
  apiKeyEnv?: string;
};

export type TelegramBotConfig = {
  botToken?: string;
  allowedProjectIds?: string[];
  allowedUserIds?: number[];
  allowedChatIds?: number[];
  defaultProjectId?: string;
  systemMessage?: string;
};

export type TelegramBotConfigMap = Record<string, TelegramBotConfig>;

type TelegramProjectBaseConfig = {
  description?: string;
};

export type TelegramRepositoryProjectConfig = TelegramProjectBaseConfig & {
  repo: string;
  ref?: string;
  workingDirectory?: string;
  persona?: string;
};

export type TelegramDirectoryProjectConfig = TelegramProjectBaseConfig & {
  directory: string;
  persona?: string;
};

export type TelegramCompositeProjectConfig = TelegramProjectBaseConfig & {
  projectIds: string[];
  persona: string;
  instructions?: string;
  subagents?: {
    launchModels?: string[];
  };
};

export type TelegramProjectConfig =
  | TelegramRepositoryProjectConfig
  | TelegramDirectoryProjectConfig
  | TelegramCompositeProjectConfig;

type ConfigDiagnostics = {
  config: Config;
  errors: string[];
};

const NonEmptyStringSchema = z.string().trim().min(1);
const ApiKeyProviderSchema = z.string();
const ApiKeysSchema = z.object({}).catchall(z.unknown());
const FlySpritesConfigSchema = z
  .object({
    baseURL: NonEmptyStringSchema.optional(),
    token: NonEmptyStringSchema.optional(),
    tokenEnv: NonEmptyStringSchema.optional(),
    home: NonEmptyStringSchema.optional(),
  })
  .strip();
const NookConfigSchema = z
  .object({
    domain: NonEmptyStringSchema,
    accessClientId: NonEmptyStringSchema.optional(),
    accessClientSecret: NonEmptyStringSchema.optional(),
    accessClientSecretEnv: NonEmptyStringSchema.optional(),
  })
  .strip();
const HistoryConfigSchema = z
  .object({
    endpoint: NonEmptyStringSchema,
    apiKey: NonEmptyStringSchema.optional(),
    apiKeyEnv: NonEmptyStringSchema.optional(),
  })
  .strip();
const SubagentsConfigSchema = z
  .object({
    launchModels: z.array(z.string()).optional(),
  })
  .strip();
const StringRecordSchema = z.object({}).catchall(z.unknown());

function parseOptionalFields(
  data: Record<string, unknown>,
  sourceLabel: string,
  specs: readonly [key: string, schema: z.ZodTypeAny, errorMessage: string][],
): { values: Record<string, unknown>; errors: string[] } {
  const values: Record<string, unknown> = {};
  const errors: string[] = [];

  for (const [key, schema, errorMessage] of specs) {
    const value = data[key];
    if (value === undefined) {
      continue;
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      errors.push(`${sourceLabel}: ${errorMessage}`);
      continue;
    }
    values[key] = parsed.data;
  }

  return { values, errors };
}
function assignParsedConfigValue<K extends keyof Config>(
  config: Config,
  errors: string[],
  key: K,
  value: Config[K] | undefined,
  parseErrors: string[],
): void {
  if (value !== undefined) {
    config[key] = value;
  }
  errors.push(...parseErrors);
}

function parseConfigJson(
  content: string,
  sourceLabel: string,
): {
  data?: unknown;
  errors: string[];
} {
  try {
    return { data: JSON.parse(content) as unknown, errors: [] };
  } catch (err) {
    return {
      errors: [
        `${sourceLabel}: failed to parse json: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }
}

function parseApiKeysConfig(
  raw: unknown,
  sourceLabel: string,
): { config?: Config["apiKeys"]; errors: string[] } {
  if (raw === undefined) {
    return { errors: [] };
  }

  const parsed = ApiKeysSchema.safeParse(raw);
  if (!parsed.success) {
    return { errors: [`${sourceLabel}: 'apiKeys' must be an object.`] };
  }

  const apiKeys: Config["apiKeys"] = {};
  const errors: string[] = [];

  for (const [rawProvider, rawValue] of Object.entries(parsed.data)) {
    const provider = rawProvider.trim();
    if (!provider) {
      errors.push(`${sourceLabel}: apiKeys keys must be non-empty strings.`);
      continue;
    }

    const parsedValue = ApiKeyProviderSchema.safeParse(rawValue);
    if (!parsedValue.success) {
      errors.push(`${sourceLabel}: apiKeys.${provider} must be a string.`);
      continue;
    }

    apiKeys[provider] = parsedValue.data;
  }

  if (Object.keys(apiKeys).length === 0) {
    return { errors };
  }

  return { config: apiKeys, errors };
}

function parseDefaultPersona(
  raw: unknown,
  sourceLabel: string,
): { defaultPersona?: string; errors: string[] } {
  if (raw === undefined) {
    return { errors: [] };
  }

  const parsedPersona = z.string().safeParse(raw);
  if (!parsedPersona.success) {
    return { errors: [`${sourceLabel}: 'defaultPersona' must be a string.`] };
  }

  const ref = parsePersonaReference(parsedPersona.data);
  if (ref.personaId && !ref.error) {
    return {
      defaultPersona: formatPersonaReference({
        personaId: ref.personaId,
        reasoning: ref.reasoning,
      }),
      errors: [],
    };
  }

  if (ref.error === "empty-persona") {
    return { errors: [`${sourceLabel}: 'defaultPersona' must be a non-empty string.`] };
  }

  if (ref.error === "missing-reasoning") {
    return {
      errors: [`${sourceLabel}: 'defaultPersona' is missing a reasoning level after ':'.`],
    };
  }

  if (ref.error === "invalid-reasoning") {
    return {
      errors: [
        `${sourceLabel}: 'defaultPersona' has invalid reasoning level '${ref.rawReasoning}'. allowed levels: ${REASONING_LEVELS.join(", ")}.`,
      ],
    };
  }

  return { errors: [] };
}

function validateConfigData(
  raw: unknown,
  sourceLabel: string,
  options: {
    scope: ConfigLevel["scope"];
    resolveModel: ModelResolver;
    resolveConfiguredModel: ModelResolver;
  },
): ConfigDiagnostics {
  if (typeof raw !== "object" || raw === null) {
    return { config: {}, errors: [`${sourceLabel}: config must be an object.`] };
  }

  const data = raw as Record<string, unknown>;
  const config: Config = {};
  const errors: string[] = [];

  if (data.apiKeys !== undefined && options.scope !== "global") {
    errors.push(`${sourceLabel}: 'apiKeys' may only be configured in the global config.`);
  } else {
    const apiKeysResult = parseApiKeysConfig(data.apiKeys, sourceLabel);
    assignParsedConfigValue(config, errors, "apiKeys", apiKeysResult.config, apiKeysResult.errors);
  }

  const defaultPersonaResult = parseDefaultPersona(data.defaultPersona, sourceLabel);
  assignParsedConfigValue(
    config,
    errors,
    "defaultPersona",
    defaultPersonaResult.defaultPersona,
    defaultPersonaResult.errors,
  );

  const scalarResult = parseOptionalFields(data, sourceLabel, [
    ["defaultTheme", NonEmptyStringSchema, "'defaultTheme' must be a non-empty string."],
    [
      "speech",
      z
        .object({
          voiceId: NonEmptyStringSchema.optional(),
          recordingShortcut: z
            .object({
              key: z
                .string()
                .refine(
                  (key) => /^[^\s\p{C}]$/u.test(key) || /^(ctrl\+y|f([1-9]|1[0-2]))$/.test(key),
                ),
              gesture: z.enum(["press", "double-tap"]),
            })
            .strict()
            .optional(),
        })
        .strip(),
      "'speech' must contain a non-empty voiceId or a recordingShortcut with a printable key, ctrl+y, or f1–f12 and a press or double-tap gesture.",
    ],
  ]);
  Object.assign(config as Record<string, unknown>, scalarResult.values);
  errors.push(...scalarResult.errors);

  if (data.clientTools !== undefined && options.scope !== "global") {
    errors.push(`${sourceLabel}: 'clientTools' may only be configured in the global config.`);
  } else {
    const clientToolsResult = parseCommandClientToolsConfig(data.clientTools, sourceLabel);
    assignParsedConfigValue(
      config,
      errors,
      "clientTools",
      clientToolsResult.config,
      clientToolsResult.errors,
    );
  }

  if (data.enabledClientTools !== undefined && options.scope !== "project") {
    errors.push(`${sourceLabel}: 'enabledClientTools' may only be configured in project config.`);
  } else {
    const enabledClientToolsResult = parseEnabledClientToolsConfig(
      data.enabledClientTools,
      sourceLabel,
    );
    assignParsedConfigValue(
      config,
      errors,
      "enabledClientTools",
      enabledClientToolsResult.config,
      enabledClientToolsResult.errors,
    );
  }

  const subagentsResult = parseSubagentsConfig(data.subagents, sourceLabel, options.resolveModel);
  assignParsedConfigValue(
    config,
    errors,
    "subagents",
    subagentsResult.config,
    subagentsResult.errors,
  );

  const modelSystemNoticesResult = parseModelSystemNotices(
    data.modelSystemNotices,
    sourceLabel,
    options.resolveConfiguredModel,
  );
  assignParsedConfigValue(
    config,
    errors,
    "modelSystemNotices",
    modelSystemNoticesResult.notices,
    modelSystemNoticesResult.errors,
  );

  const flySpritesResult = parseFlySpritesConfig(data.flySprites, sourceLabel);
  assignParsedConfigValue(
    config,
    errors,
    "flySprites",
    flySpritesResult.config,
    flySpritesResult.errors,
  );

  const nookResult = parseNookConfig(data.nook, sourceLabel);
  assignParsedConfigValue(config, errors, "nook", nookResult.config, nookResult.errors);

  if (data.history !== undefined && options.scope !== "global") {
    errors.push(`${sourceLabel}: 'history' may only be configured in the global config.`);
  } else {
    const historyResult = parseHistoryConfig(data.history, sourceLabel);
    assignParsedConfigValue(config, errors, "history", historyResult.config, historyResult.errors);
  }

  const mcpResult = parseMcpServersConfig(data.mcpServers, sourceLabel);
  assignParsedConfigValue(config, errors, "mcpServers", mcpResult.config, mcpResult.errors);

  return { config, errors };
}

function parseFlySpritesConfig(
  raw: unknown,
  sourceLabel: string,
): { config?: FlySpritesConfig; errors: string[] } {
  if (raw === undefined) {
    return { errors: [] };
  }

  const parsed = FlySpritesConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      errors: [`${sourceLabel}: 'flySprites' must contain connection options.`],
    };
  }

  return { config: parsed.data, errors: [] };
}

function parseNookConfig(
  raw: unknown,
  sourceLabel: string,
): { config?: NookConfig; errors: string[] } {
  if (raw === undefined) {
    return { errors: [] };
  }

  const parsed = NookConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      errors: [
        `${sourceLabel}: 'nook' must be an object with domain and optional Access service token credentials.`,
      ],
    };
  }

  let domain: string;
  try {
    domain = normalizeNookDomain(parsed.data.domain);
  } catch (error) {
    return {
      errors: [
        `${sourceLabel}: ${error instanceof Error ? error.message : "nook.domain must be a DNS hostname without a path."}`,
      ],
    };
  }

  return {
    config: {
      domain,
      ...(parsed.data.accessClientId !== undefined
        ? { accessClientId: parsed.data.accessClientId }
        : {}),
      ...(parsed.data.accessClientSecret !== undefined
        ? { accessClientSecret: parsed.data.accessClientSecret }
        : {}),
      ...(parsed.data.accessClientSecretEnv !== undefined
        ? { accessClientSecretEnv: parsed.data.accessClientSecretEnv }
        : {}),
    },
    errors: [],
  };
}

function parseHistoryConfig(
  raw: unknown,
  sourceLabel: string,
): { config?: HistoryConfig; errors: string[] } {
  if (raw === undefined) {
    return { errors: [] };
  }

  const parsed = HistoryConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      errors: [
        `${sourceLabel}: 'history' must be an object with an endpoint and optional API key configuration.`,
      ],
    };
  }

  let endpoint: string;
  try {
    const url = new URL(parsed.data.endpoint);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error();
    }
    endpoint = url.toString().replace(/\/+$/, "");
  } catch {
    return {
      errors: [
        `${sourceLabel}: history.endpoint must be an HTTP(S) URL without credentials, a query, or a hash.`,
      ],
    };
  }

  return {
    config: {
      endpoint,
      ...(parsed.data.apiKey !== undefined ? { apiKey: parsed.data.apiKey } : {}),
      ...(parsed.data.apiKeyEnv !== undefined ? { apiKeyEnv: parsed.data.apiKeyEnv } : {}),
    },
    errors: [],
  };
}

function parseSubagentsConfig(
  raw: unknown,
  sourceLabel: string,
  modelResolver: ModelResolver,
): { config?: Config["subagents"]; errors: string[] } {
  if (raw === undefined) {
    return { errors: [] };
  }

  const parsed = SubagentsConfigSchema.safeParse(raw);
  if (!parsed.success) {
    if (parsed.error.issues.some((issue) => issue.path[0] === "launchModels")) {
      return { errors: [`${sourceLabel}: subagents.launchModels must be a string array.`] };
    }
    return { errors: [`${sourceLabel}: 'subagents' must be an object.`] };
  }

  const { launchModels } = parsed.data;
  if (launchModels === undefined) {
    return { errors: [] };
  }

  const launchModelsResult = parseSubagentLaunchModelList(launchModels, {
    resolveModel: modelResolver,
  });
  if (launchModelsResult.error) {
    return {
      errors: [
        `${sourceLabel}: subagents.launchModels ${launchModelsResult.error}. expected <provider>/<model>:<effort>.`,
      ],
    };
  }

  return {
    config: {
      launchModels: launchModelsResult.launchModels,
    },
    errors: [],
  };
}

function parseModelNoticeTarget(
  rawKey: string,
  modelResolver: ModelResolver,
): { normalizedKey?: string; error?: string } {
  const parsedKey = parseModelNoticeKey(rawKey);
  if (!parsedKey) {
    return { error: "must use keys in format '<provider>/<model>'" };
  }

  const provider = parsedKey.provider;
  if (!listProviders().includes(provider)) {
    return { error: `unknown provider '${parsedKey.provider}'` };
  }

  const model = modelResolver(provider, parsedKey.modelId);
  if (!model) {
    return {
      error: `unknown model '${parsedKey.provider}/${parsedKey.modelId}'`,
    };
  }

  return {
    normalizedKey: normalizeModelNoticeKey(provider, model.id),
  };
}

function parseModelSystemNotices(
  raw: unknown,
  sourceLabel: string,
  modelResolver: ModelResolver,
): { notices?: Record<string, string>; errors: string[] } {
  if (raw === undefined) {
    return { errors: [] };
  }

  const parsedRecord = StringRecordSchema.safeParse(raw);
  if (!parsedRecord.success) {
    return { errors: [`${sourceLabel}: 'modelSystemNotices' must be an object.`] };
  }

  const notices: Record<string, string> = {};
  const errors: string[] = [];

  for (const [rawKey, rawValue] of Object.entries(parsedRecord.data)) {
    const parsedKey = parseModelNoticeTarget(rawKey, modelResolver);
    if (parsedKey.error || !parsedKey.normalizedKey) {
      errors.push(
        `${sourceLabel}: modelSystemNotices.${rawKey} ${parsedKey.error ?? "is invalid"}.`,
      );
      continue;
    }

    const parsedNotice = NonEmptyStringSchema.safeParse(rawValue);
    if (!parsedNotice.success) {
      errors.push(
        `${sourceLabel}: modelSystemNotices.${rawKey} must be a non-empty string notice.`,
      );
      continue;
    }

    notices[parsedKey.normalizedKey] = parsedNotice.data;
  }

  if (Object.keys(notices).length === 0) {
    return { errors };
  }

  return { notices, errors };
}

function loadConfigFile(
  level: ConfigLevel,
  deps: ConfigDeps,
  sourceLabel: string,
  options: {
    resolveModel: ModelResolver;
    resolveConfiguredModel: ModelResolver;
  },
): ConfigDiagnostics {
  try {
    if (!deps.fs.exists(level.configPath)) {
      return { config: {}, errors: [] };
    }

    const content = deps.fs.readFile(level.configPath);
    const parsed = parseConfigJson(content, sourceLabel);
    if (parsed.data === undefined) {
      return { config: {}, errors: parsed.errors };
    }

    const validated = validateConfigData(parsed.data, sourceLabel, {
      ...options,
      scope: level.scope,
    });
    return { config: validated.config, errors: [...parsed.errors, ...validated.errors] };
  } catch (err) {
    return {
      config: {},
      errors: [
        `${sourceLabel}: failed to read config: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }
}

function mergeOptionalObject<T extends object>(
  target: T | undefined,
  overlay: T | undefined,
): T | undefined {
  if (!target && !overlay) {
    return undefined;
  }

  return {
    ...(target ?? {}),
    ...(overlay ?? {}),
  } as T;
}

function mergeSubagentsConfig(
  target: Config["subagents"] | undefined,
  overlay: Config["subagents"] | undefined,
): Config["subagents"] | undefined {
  if (!target && !overlay) {
    return undefined;
  }

  const merged: NonNullable<Config["subagents"]> = {
    ...(target ?? {}),
  };

  if (overlay?.launchModels !== undefined) {
    merged.launchModels = [...overlay.launchModels];
  }

  return merged;
}

function mergeConfigLevels(levels: ConfigLevel[], configs: Config[], home: string): Config {
  const merged: Config = getVirtualConfigDefaults();
  let apiKeys: Config["apiKeys"] | undefined;
  let clientTools: CommandClientToolConfig[] | undefined;
  let enabledClientTools: string[] | undefined;
  let subagents: Config["subagents"] | undefined;
  let modelSystemNotices: Config["modelSystemNotices"] | undefined;
  let flySprites: FlySpritesConfig | undefined;
  let nook: NookConfig | undefined;
  let history: HistoryConfig | undefined;

  for (let i = 0; i < levels.length; i += 1) {
    const level = levels[i]!;
    const config = configs[i] ?? {};

    apiKeys = mergeOptionalObject(apiKeys, config.apiKeys);
    if (config.speech !== undefined) {
      merged.speech = mergeOptionalObject(merged.speech, config.speech);
    }
    if (config.clientTools !== undefined) {
      clientTools = resolveCommandClientToolsConfig(level, config.clientTools);
    }
    if (config.enabledClientTools !== undefined) {
      enabledClientTools = [...config.enabledClientTools];
    }
    subagents = mergeSubagentsConfig(subagents, config.subagents);
    modelSystemNotices = mergeOptionalObject(modelSystemNotices, config.modelSystemNotices);
    flySprites = mergeOptionalObject(flySprites, config.flySprites);
    if (config.nook !== undefined) {
      nook = { ...config.nook };
    }
    if (config.history !== undefined) {
      history = { ...config.history };
    }
    if (config.mcpServers !== undefined) {
      merged.mcpServers = {
        ...merged.mcpServers,
        ...resolveMcpServersConfig(level, config.mcpServers, home),
      };
    }

    if (config.defaultPersona !== undefined) {
      merged.defaultPersona = config.defaultPersona;
    }

    if (config.defaultTheme !== undefined) {
      merged.defaultTheme = config.defaultTheme;
    }
  }

  if (apiKeys && Object.keys(apiKeys).length > 0) {
    merged.apiKeys = apiKeys;
  }

  if (clientTools) {
    const selectedClientTools = selectCommandClientTools(clientTools, enabledClientTools);
    if (selectedClientTools.length > 0) {
      merged.clientTools = selectedClientTools;
    }
  }

  if (subagents && Object.keys(subagents).length > 0) {
    merged.subagents = subagents;
  }

  if (modelSystemNotices && Object.keys(modelSystemNotices).length > 0) {
    merged.modelSystemNotices = modelSystemNotices;
  }

  if (flySprites) {
    merged.flySprites = flySprites;
  }

  if (nook) {
    merged.nook = nook;
  }

  if (history) {
    merged.history = history;
  }

  return merged;
}

export function loadConfigWithDiagnostics(
  deps: ConfigDeps,
  options: {
    levels: ConfigLevel[];
    modelResolver: LoadedModelResolver;
  },
): { config: Config; errors: string[] } {
  const modelResolverResult = options.modelResolver;

  const results = options.levels.map((level) =>
    loadConfigFile(level, deps, level.configPath, {
      resolveModel: modelResolverResult.resolveModel,
      resolveConfiguredModel: modelResolverResult.resolveConfiguredModel,
    }),
  );

  return {
    config: mergeConfigLevels(
      options.levels,
      results.map((result) => result.config),
      deps.env.home(),
    ),
    errors: results.flatMap((result) => result.errors),
  };
}

export function loadConfig(cwd: string, deps: ConfigDeps): Config {
  const levels = resolveConfigLevels(deps, { cwd });
  const modelResolver = loadModelResolver();
  return loadConfigWithDiagnostics(deps, { levels, modelResolver }).config;
}

export function getApiKeyForProvider(config: Config, provider: string): string | undefined {
  const apiKeys = config.apiKeys;
  if (!apiKeys) {
    return undefined;
  }

  const key = apiKeys[provider];
  if (typeof key !== "string") {
    return undefined;
  }

  const trimmed = key.trim();
  return trimmed || undefined;
}

function getTrimmedEnvValue(key: string, env?: NodeJS.ProcessEnv): string | undefined {
  const source = env ?? process.env;
  const value = source[key];
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

export function getExaApiKey(config: Config, env?: NodeJS.ProcessEnv): string | undefined {
  const envKey = getTrimmedEnvValue("EXA_API_KEY", env);
  if (envKey) {
    return envKey;
  }

  const configKey = config.apiKeys?.exa?.trim();
  return configKey || undefined;
}

export function getGoogleApiKey(config: Config, env?: NodeJS.ProcessEnv): string | undefined {
  const envKey = getTrimmedEnvValue("GEMINI_API_KEY", env);
  if (envKey) {
    return envKey;
  }

  const configKey = config.apiKeys?.google?.trim();
  return configKey || undefined;
}

export function getOpenAIApiKey(config: Config, env?: NodeJS.ProcessEnv): string | undefined {
  const envKey = getTrimmedEnvValue("OPENAI_API_KEY", env);
  if (envKey) {
    return envKey;
  }

  const configKey = config.apiKeys?.openai?.trim();
  return configKey || undefined;
}

export function getElevenLabsApiKey(config: Config, env?: NodeJS.ProcessEnv): string | undefined {
  const envKey = getTrimmedEnvValue("ELEVENLABS_API_KEY", env);
  if (envKey) {
    return envKey;
  }

  const configKey = config.apiKeys?.elevenlabs?.trim();
  return configKey || undefined;
}

export function getMistralApiKey(config: Config, env?: NodeJS.ProcessEnv): string | undefined {
  const envKey = getTrimmedEnvValue("MISTRAL_API_KEY", env);
  if (envKey) {
    return envKey;
  }

  const configKey = config.apiKeys?.mistral?.trim();
  return configKey || undefined;
}

export function getHistoryApiKey(
  config: HistoryConfig,
  env?: NodeJS.ProcessEnv,
): string | undefined {
  const standardEnvSecret = getTrimmedEnvValue("TAU_HISTORY_API_KEY", env);
  if (standardEnvSecret) return standardEnvSecret;
  const envName = config.apiKeyEnv?.trim();
  if (envName) {
    const envSecret = getTrimmedEnvValue(envName, env);
    if (envSecret) return envSecret;
  }
  return config.apiKey?.trim() || undefined;
}

export function getNookAccessClientSecret(
  config: NookConfig,
  env?: NodeJS.ProcessEnv,
): string | undefined {
  const envName = config.accessClientSecretEnv?.trim();
  if (envName) {
    const envSecret = getTrimmedEnvValue(envName, env);
    if (envSecret) {
      return envSecret;
    }
  }

  return config.accessClientSecret?.trim() || undefined;
}
