import { resolve } from "node:path";
import { z } from "zod";
import {
  type LoadedModelResolver,
  listProviders,
  loadModelResolver,
  type ModelResolver,
} from "../models/catalog.js";
import { formatPersonaReference, parsePersonaReference } from "../persona_reference.js";
import { parseSubagentLaunchModelList } from "../subagents/launch_model.js";
import { REASONING_LEVELS, type RiskLevel, RiskLevelSchema } from "../types.js";
import { normalizeModelNoticeKey, parseModelNoticeKey } from "../utils/model_notices.js";
import type { ConfigDeps } from "./deps.js";
import type { DiffToolConfig } from "./diff_tool.js";
import { parseDiffToolConfig, resolveDiffToolConfig } from "./diff_tool.js";
import type { ConfigLevel } from "./paths.js";
import { resolveConfigLevels } from "./paths.js";
import { getVirtualConfigDefaults } from "./virtual_defaults.js";

export interface Config {
  apiKeys?: Record<string, string>;
  defaultPersona?: string;
  defaultRisk?: RiskLevel;
  disableBuiltinPersonas?: boolean;
  disableBuiltinThemes?: boolean;
  defaultTheme?: string;
  diffTool?: DiffToolConfig;
  builtInDiffTool?: BuiltInDiffToolConfig;
  agentContextFiles?: string[];
  subagents?: {
    defaultLaunchModels?: string[];
  };
  autoCompact?: AutoCompactConfig;
  modelSystemNotices?: Record<string, string>;
  speechToText?: SpeechToTextConfig;
  cloudflareSandbox?: CloudflareSandboxConfig;
  flySprites?: FlySpritesConfig;
}

export type BuiltInDiffToolConfig = {
  codeTheme?: string;
};

export type SpeechToTextProvider = "mistral" | "gemini";

export type SpeechToTextConfig = {
  provider: SpeechToTextProvider;
};

export type CloudflareSandboxBridgeConfig = {
  url: string;
  apiKey?: string;
  apiKeyEnv?: string;
  home?: string;
};

export type CloudflareSandboxConfig = {
  bridges?: Record<string, CloudflareSandboxBridgeConfig>;
};

export type FlySpritesApiConfig = {
  baseURL?: string;
  token?: string;
  tokenEnv?: string;
  home?: string;
};

export type FlySpritesConfig = {
  apis?: Record<string, FlySpritesApiConfig>;
};

export type AutoCompactConfig = {
  enabled?: boolean;
  reserveTokens?: number;
  keepRecentTokens?: number;
};

export type NormalizedAutoCompactConfig = Required<AutoCompactConfig>;

export const DEFAULT_AUTO_COMPACT_CONFIG: NormalizedAutoCompactConfig = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
};

export function normalizeAutoCompactConfig(
  config: AutoCompactConfig | undefined,
): NormalizedAutoCompactConfig {
  return { ...DEFAULT_AUTO_COMPACT_CONFIG, ...config };
}

export type TelegramBotConfig = {
  botToken?: string;
  allowedProjectIds?: string[];
  allowedUserIds?: number[];
  allowedChatIds?: number[];
  defaultProjectId?: string;
  systemMessage?: string;
  pollIntervalMs?: number;
  requestTimeoutSeconds?: number;
};

export type TelegramBotConfigMap = Record<string, TelegramBotConfig>;

export type TelegramProjectConfig = {
  repo: string;
  ref?: string;
  workspaceRoot?: string;
  workingDirectory?: string;
  description?: string;
  bootstrapCommands?: string[];
  backgroundBootstrapCommands?: string[];
  persona?: string;
  riskLevel?: RiskLevel;
  noAgentContextFiles?: boolean;
};

type ConfigDiagnostics = {
  config: Config;
  errors: string[];
};

const BUILT_IN_DIFF_TOOL_CODE_THEMES = new Set([
  "andromeeda",
  "aurora-x",
  "ayu-dark",
  "ayu-mirage",
  "catppuccin-frappe",
  "catppuccin-macchiato",
  "catppuccin-mocha",
  "dark-plus",
  "dracula",
  "dracula-soft",
  "everforest-dark",
  "github-dark",
  "github-dark-default",
  "github-dark-dimmed",
  "github-dark-high-contrast",
  "gruvbox-dark-hard",
  "gruvbox-dark-medium",
  "gruvbox-dark-soft",
  "horizon",
  "horizon-bright",
  "houston",
  "kanagawa-dragon",
  "kanagawa-wave",
  "laserwave",
  "material-theme",
  "material-theme-darker",
  "material-theme-ocean",
  "material-theme-palenight",
  "min-dark",
  "monokai",
  "night-owl",
  "nord",
  "one-dark-pro",
  "plastic",
  "poimandres",
  "red",
  "rose-pine",
  "rose-pine-moon",
  "slack-dark",
  "solarized-dark",
  "synthwave-84",
  "tokyo-night",
  "vesper",
  "vitesse-black",
  "vitesse-dark",
]);

const BuiltInDiffToolSchema = z
  .object({
    codeTheme: z.string().trim().min(1).optional(),
  })
  .passthrough();

const KNOWN_TOP_LEVEL_CONFIG_KEYS = new Set([
  "apiKeys",
  "defaultPersona",
  "defaultRisk",
  "disableBuiltinPersonas",
  "disableBuiltinThemes",
  "defaultTheme",
  "diffTool",
  "builtInDiffTool",
  "agentContextFiles",
  "subagents",
  "autoCompact",
  "modelSystemNotices",
  "speechToText",
  "cloudflareSandbox",
  "flySprites",
]);

const NonEmptyStringSchema = z.string().trim().min(1);
const BooleanSchema = z.boolean();
const AgentContextFilesSchema = z.array(NonEmptyStringSchema);
const ApiKeyProviderSchema = z.string();
const ApiKeysSchema = z.object({}).catchall(z.unknown());
const SpeechToTextConfigSchema = z
  .object({
    provider: z.enum(["mistral", "gemini"]),
  })
  .passthrough();
const CloudflareSandboxBridgeSchema = z
  .object({
    url: NonEmptyStringSchema,
    apiKey: NonEmptyStringSchema.optional(),
    apiKeyEnv: NonEmptyStringSchema.optional(),
    home: NonEmptyStringSchema.optional(),
  })
  .strict();
const CloudflareSandboxConfigSchema = z
  .object({
    bridges: z.record(NonEmptyStringSchema, CloudflareSandboxBridgeSchema).optional(),
  })
  .strict();
const FlySpritesApiSchema = z
  .object({
    baseURL: NonEmptyStringSchema.optional(),
    token: NonEmptyStringSchema.optional(),
    tokenEnv: NonEmptyStringSchema.optional(),
    home: NonEmptyStringSchema.optional(),
  })
  .strict();
const FlySpritesConfigSchema = z
  .object({
    apis: z.record(NonEmptyStringSchema, FlySpritesApiSchema).optional(),
  })
  .strict();
const SubagentsConfigSchema = z
  .object({
    defaultLaunchModels: z.array(z.string()).optional(),
  })
  .passthrough();
const StringRecordSchema = z.object({}).catchall(z.unknown());
const PositiveIntegerSchema = z.number().int().finite().gt(0);
const AutoCompactConfigSchema = z
  .object({
    enabled: BooleanSchema.optional(),
    reserveTokens: PositiveIntegerSchema.optional(),
    keepRecentTokens: PositiveIntegerSchema.optional(),
  })
  .strict();

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

  const unknownKeys = Object.keys(data).filter((key) => !KNOWN_TOP_LEVEL_CONFIG_KEYS.has(key));
  if (unknownKeys.length > 0) {
    const keyLabel = unknownKeys.length === 1 ? "key" : "keys";
    errors.push(`${sourceLabel}: unknown ${keyLabel} in config: ${unknownKeys.sort().join(", ")}.`);
  }

  const apiKeysResult = parseApiKeysConfig(data.apiKeys, sourceLabel);
  assignParsedConfigValue(config, errors, "apiKeys", apiKeysResult.config, apiKeysResult.errors);

  const defaultPersonaResult = parseDefaultPersona(data.defaultPersona, sourceLabel);
  assignParsedConfigValue(
    config,
    errors,
    "defaultPersona",
    defaultPersonaResult.defaultPersona,
    defaultPersonaResult.errors,
  );

  const scalarResult = parseOptionalFields(data, sourceLabel, [
    ["defaultRisk", RiskLevelSchema, "'defaultRisk' must be a valid risk level."],
    ["disableBuiltinPersonas", BooleanSchema, "'disableBuiltinPersonas' must be a boolean."],
    ["disableBuiltinThemes", BooleanSchema, "'disableBuiltinThemes' must be a boolean."],
    ["defaultTheme", NonEmptyStringSchema, "'defaultTheme' must be a non-empty string."],
  ]);
  Object.assign(config as Record<string, unknown>, scalarResult.values);
  errors.push(...scalarResult.errors);

  const diffToolResult = parseDiffToolConfig(data.diffTool, sourceLabel);
  assignParsedConfigValue(config, errors, "diffTool", diffToolResult.config, diffToolResult.errors);

  const builtInDiffToolResult = parseBuiltInDiffToolConfig(data.builtInDiffTool, sourceLabel);
  assignParsedConfigValue(
    config,
    errors,
    "builtInDiffTool",
    builtInDiffToolResult.config,
    builtInDiffToolResult.errors,
  );

  const agentResult = parseAgentContextFiles(data.agentContextFiles, sourceLabel);
  assignParsedConfigValue(
    config,
    errors,
    "agentContextFiles",
    agentResult.paths.length > 0 ? agentResult.paths : undefined,
    agentResult.errors,
  );

  const subagentsResult = parseSubagentsConfig(data.subagents, sourceLabel, options.resolveModel);
  assignParsedConfigValue(
    config,
    errors,
    "subagents",
    subagentsResult.config,
    subagentsResult.errors,
  );

  const autoCompactResult = parseAutoCompactConfig(data.autoCompact, sourceLabel);
  assignParsedConfigValue(
    config,
    errors,
    "autoCompact",
    autoCompactResult.config,
    autoCompactResult.errors,
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

  const speechToTextResult = parseSpeechToTextConfig(data.speechToText, sourceLabel);
  assignParsedConfigValue(
    config,
    errors,
    "speechToText",
    speechToTextResult.config,
    speechToTextResult.errors,
  );

  const cloudflareSandboxResult = parseCloudflareSandboxConfig(data.cloudflareSandbox, sourceLabel);
  assignParsedConfigValue(
    config,
    errors,
    "cloudflareSandbox",
    cloudflareSandboxResult.config,
    cloudflareSandboxResult.errors,
  );

  const flySpritesResult = parseFlySpritesConfig(data.flySprites, sourceLabel);
  assignParsedConfigValue(
    config,
    errors,
    "flySprites",
    flySpritesResult.config,
    flySpritesResult.errors,
  );

  return { config, errors };
}

function parseAgentContextFiles(
  raw: unknown,
  sourceLabel: string,
): { paths: string[]; errors: string[] } {
  if (raw === undefined) {
    return { paths: [], errors: [] };
  }

  const parsed = AgentContextFilesSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      paths: [],
      errors: [`${sourceLabel}: 'agentContextFiles' must be a string array.`],
    };
  }

  return { paths: parsed.data, errors: [] };
}

function parseBuiltInDiffToolConfig(
  raw: unknown,
  sourceLabel: string,
): { config?: BuiltInDiffToolConfig; errors: string[] } {
  if (raw === undefined) {
    return { errors: [] };
  }

  const parsed = BuiltInDiffToolSchema.safeParse(raw);
  if (!parsed.success) {
    return { errors: [`${sourceLabel}: 'builtInDiffTool' must be an object.`] };
  }

  const config: BuiltInDiffToolConfig = {};
  const codeTheme = parsed.data.codeTheme;
  if (codeTheme !== undefined) {
    if (!BUILT_IN_DIFF_TOOL_CODE_THEMES.has(codeTheme)) {
      return { errors: [`${sourceLabel}: builtInDiffTool.codeTheme is not supported.`] };
    }
    config.codeTheme = codeTheme;
  }

  return { config: Object.keys(config).length > 0 ? config : undefined, errors: [] };
}

function parseSpeechToTextConfig(
  raw: unknown,
  sourceLabel: string,
): { config?: SpeechToTextConfig; errors: string[] } {
  if (raw === undefined) {
    return { errors: [] };
  }

  const parsed = SpeechToTextConfigSchema.safeParse(raw);
  if (!parsed.success) {
    if (parsed.error.issues.some((issue) => issue.path[0] === "provider")) {
      return {
        errors: [`${sourceLabel}: speechToText.provider must be 'mistral' or 'gemini'.`],
      };
    }
    return { errors: [`${sourceLabel}: 'speechToText' must be an object.`] };
  }

  return { config: { provider: parsed.data.provider }, errors: [] };
}

function parseCloudflareSandboxConfig(
  raw: unknown,
  sourceLabel: string,
): { config?: CloudflareSandboxConfig; errors: string[] } {
  if (raw === undefined) {
    return { errors: [] };
  }

  const parsed = CloudflareSandboxConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      errors: [
        `${sourceLabel}: 'cloudflareSandbox' must be an object with a 'bridges' map of bridge configs.`,
      ],
    };
  }

  const bridges = parsed.data.bridges;
  return {
    config: bridges && Object.keys(bridges).length > 0 ? { bridges } : undefined,
    errors: [],
  };
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
      errors: [`${sourceLabel}: 'flySprites' must be an object with an 'apis' map of API configs.`],
    };
  }

  const apis = parsed.data.apis;
  return {
    config: apis && Object.keys(apis).length > 0 ? { apis } : undefined,
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
    if (parsed.error.issues.some((issue) => issue.path[0] === "defaultLaunchModels")) {
      return { errors: [`${sourceLabel}: subagents.defaultLaunchModels must be a string array.`] };
    }
    return { errors: [`${sourceLabel}: 'subagents' must be an object.`] };
  }

  const { defaultLaunchModels } = parsed.data;
  if (defaultLaunchModels === undefined) {
    return { errors: [] };
  }

  const launchModelsResult = parseSubagentLaunchModelList(defaultLaunchModels, {
    resolveModel: modelResolver,
  });
  if (launchModelsResult.error) {
    return {
      errors: [
        `${sourceLabel}: subagents.defaultLaunchModels ${launchModelsResult.error}. expected <provider>/<model>:<effort>.`,
      ],
    };
  }

  return {
    config: {
      defaultLaunchModels: launchModelsResult.launchModels,
    },
    errors: [],
  };
}

function parseAutoCompactConfig(
  raw: unknown,
  sourceLabel: string,
): { config?: AutoCompactConfig; errors: string[] } {
  if (raw === undefined) {
    return { errors: [] };
  }

  const parsed = AutoCompactConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const errors = new Set<string>();
    if (parsed.error.issues.some((issue) => issue.path[0] === "enabled")) {
      errors.add(`${sourceLabel}: autoCompact.enabled must be a boolean.`);
    }
    if (parsed.error.issues.some((issue) => issue.path[0] === "reserveTokens")) {
      errors.add(`${sourceLabel}: autoCompact.reserveTokens must be a positive integer.`);
    }
    if (parsed.error.issues.some((issue) => issue.path[0] === "keepRecentTokens")) {
      errors.add(`${sourceLabel}: autoCompact.keepRecentTokens must be a positive integer.`);
    }
    for (const issue of parsed.error.issues) {
      if (issue.code === "unrecognized_keys") {
        const keyLabel = issue.keys.length === 1 ? "key" : "keys";
        errors.add(
          `${sourceLabel}: unknown ${keyLabel} in autoCompact: ${issue.keys.sort().join(", ")}.`,
        );
      }
    }
    if (errors.size === 0) {
      errors.add(`${sourceLabel}: 'autoCompact' must be an object.`);
    }
    return { errors: [...errors] };
  }

  if (Object.keys(parsed.data).length === 0) {
    return { errors: [] };
  }

  return { config: parsed.data, errors: [] };
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

    const validated = validateConfigData(parsed.data, sourceLabel, options);
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

  if (overlay?.defaultLaunchModels !== undefined) {
    merged.defaultLaunchModels = [...overlay.defaultLaunchModels];
  }

  return merged;
}

function mergeCloudflareSandboxConfig(
  target: CloudflareSandboxConfig | undefined,
  overlay: CloudflareSandboxConfig | undefined,
): CloudflareSandboxConfig | undefined {
  if (!target && !overlay) {
    return undefined;
  }

  const bridges = new Map<string, CloudflareSandboxBridgeConfig>();
  for (const [id, bridge] of Object.entries(target?.bridges ?? {})) {
    bridges.set(id, { ...bridge });
  }
  for (const [id, bridge] of Object.entries(overlay?.bridges ?? {})) {
    bridges.set(id, { ...bridge });
  }

  return bridges.size > 0 ? { bridges: Object.fromEntries(bridges.entries()) } : undefined;
}

function mergeFlySpritesConfig(
  target: FlySpritesConfig | undefined,
  overlay: FlySpritesConfig | undefined,
): FlySpritesConfig | undefined {
  if (!target && !overlay) {
    return undefined;
  }

  const apis = new Map<string, FlySpritesApiConfig>();
  for (const [id, api] of Object.entries(target?.apis ?? {})) {
    apis.set(id, { ...api });
  }
  for (const [id, api] of Object.entries(overlay?.apis ?? {})) {
    apis.set(id, { ...api });
  }

  return apis.size > 0 ? { apis: Object.fromEntries(apis.entries()) } : undefined;
}

function resolveAgentContextPaths(level: ConfigLevel, rawPaths: string[]): string[] {
  const root = level.levelRoot;
  return rawPaths.map((entry) => resolve(root, entry));
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    unique.push(path);
  }
  return unique;
}

function mergeConfigLevels(levels: ConfigLevel[], configs: Config[]): Config {
  const merged: Config = getVirtualConfigDefaults();
  let apiKeys: Config["apiKeys"] | undefined;
  let diffTool: DiffToolConfig | undefined;
  let builtInDiffTool: BuiltInDiffToolConfig | undefined;
  let subagents: Config["subagents"] | undefined;
  let modelSystemNotices: Config["modelSystemNotices"] | undefined;
  let speechToText: SpeechToTextConfig | undefined;
  let cloudflareSandbox: CloudflareSandboxConfig | undefined;
  let flySprites: FlySpritesConfig | undefined;
  const agentContextFiles: string[] = [];

  for (let i = 0; i < levels.length; i += 1) {
    const level = levels[i]!;
    const config = configs[i] ?? {};

    apiKeys = mergeOptionalObject(apiKeys, config.apiKeys);
    if (config.diffTool !== undefined) {
      diffTool = resolveDiffToolConfig(level, config.diffTool);
    }
    if (config.builtInDiffTool !== undefined) {
      builtInDiffTool = { ...config.builtInDiffTool };
    }
    subagents = mergeSubagentsConfig(subagents, config.subagents);
    if (config.autoCompact !== undefined) {
      merged.autoCompact = mergeOptionalObject(merged.autoCompact, config.autoCompact);
    }
    modelSystemNotices = mergeOptionalObject(modelSystemNotices, config.modelSystemNotices);
    if (config.speechToText !== undefined) {
      speechToText = { ...config.speechToText };
    }
    cloudflareSandbox = mergeCloudflareSandboxConfig(cloudflareSandbox, config.cloudflareSandbox);
    flySprites = mergeFlySpritesConfig(flySprites, config.flySprites);

    if (config.defaultPersona !== undefined) {
      merged.defaultPersona = config.defaultPersona;
    }

    if (config.defaultRisk !== undefined) {
      merged.defaultRisk = config.defaultRisk;
    }

    if (config.disableBuiltinPersonas !== undefined) {
      merged.disableBuiltinPersonas = config.disableBuiltinPersonas;
    }

    if (config.disableBuiltinThemes !== undefined) {
      merged.disableBuiltinThemes = config.disableBuiltinThemes;
    }

    if (config.defaultTheme !== undefined) {
      merged.defaultTheme = config.defaultTheme;
    }

    if (config.agentContextFiles) {
      agentContextFiles.push(...resolveAgentContextPaths(level, config.agentContextFiles));
    }
  }

  if (apiKeys && Object.keys(apiKeys).length > 0) {
    merged.apiKeys = apiKeys;
  }

  if (diffTool) {
    merged.diffTool = diffTool;
  }

  if (builtInDiffTool) {
    merged.builtInDiffTool = builtInDiffTool;
  }

  if (subagents && Object.keys(subagents).length > 0) {
    merged.subagents = subagents;
  }

  if (modelSystemNotices && Object.keys(modelSystemNotices).length > 0) {
    merged.modelSystemNotices = modelSystemNotices;
  }

  if (speechToText) {
    merged.speechToText = speechToText;
  }

  if (cloudflareSandbox) {
    merged.cloudflareSandbox = cloudflareSandbox;
  }

  if (flySprites) {
    merged.flySprites = flySprites;
  }

  if (agentContextFiles.length > 0) {
    merged.agentContextFiles = dedupePaths(agentContextFiles);
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
    ),
    errors: [...modelResolverResult.errors, ...results.flatMap((result) => result.errors)],
  };
}

export function loadConfig(cwd: string, deps: ConfigDeps): Config {
  const levels = resolveConfigLevels(deps, { cwd });
  const modelResolver = loadModelResolver({ deps, levels });
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

export function getParallelApiKey(config: Config, env?: NodeJS.ProcessEnv): string | undefined {
  const envKey = getTrimmedEnvValue("PARALLEL_API_KEY", env);
  if (envKey) {
    return envKey;
  }

  const configKey = config.apiKeys?.parallel?.trim();
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

export function getMistralApiKey(config: Config, env?: NodeJS.ProcessEnv): string | undefined {
  const envKey = getTrimmedEnvValue("MISTRAL_API_KEY", env);
  if (envKey) {
    return envKey;
  }

  const configKey = config.apiKeys?.mistral?.trim();
  return configKey || undefined;
}
