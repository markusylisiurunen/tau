import { resolve } from "node:path";
import { z } from "zod";
import { listProviders, loadModelResolver, type ModelResolver } from "../models/catalog.js";
import { formatPersonaReference, parsePersonaReference } from "../persona_reference.js";
import { parseSubagentLaunchModelList } from "../subagents/launch_model.js";
import { REASONING_LEVELS, type RiskLevel, RiskLevelSchema } from "../types.js";
import { normalizeModelNoticeKey, parseModelNoticeKey } from "../utils/model_notices.js";
import type { BashCommand } from "./bash_commands.js";
import { parseBashCommands } from "./bash_commands.js";
import type { ConfigDeps } from "./deps.js";
import { createDefaultConfigDeps } from "./deps.js";
import type { ConfigLevel } from "./paths.js";
import { resolveConfigLevels } from "./paths.js";
import { getVirtualConfigDefaults } from "./virtual_defaults.js";

export interface Config {
  apiKeys?: Record<string, string>;
  sandbox?: SandboxConfig;
  defaultPersona?: string;
  defaultRisk?: RiskLevel;
  disableBuiltinPersonas?: boolean;
  disableBuiltinThemes?: boolean;
  defaultTheme?: string;
  bashCommands?: BashCommand[];
  agentContextFiles?: string[];
  subagents?: {
    defaultLaunchModels?: string[];
  };
  modelSystemNotices?: Record<string, string>;
  async?: AsyncConfig;
}

export type SandboxConfig = {
  image?: string;
  mountPath?: string;
  pruneAfterHours?: number;
  extraDockerArgs?: string[];
  environmentInfo?: string;
};

export type AsyncClientTargetConfig = {
  url: string;
  token: string;
  timeoutMs?: number;
};

export type AsyncClientConfig = {
  defaultTarget?: string;
  defaultProjectId?: string;
  targets?: Record<string, AsyncClientTargetConfig>;
};

export type AsyncServerTelegramBotConfig = {
  botToken?: string;
  allowedProjectIds?: string[];
  allowedUserIds?: number[];
  allowedChatIds?: number[];
  defaultProjectId?: string;
  systemMessage?: string;
  pollIntervalMs?: number;
  requestTimeoutSeconds?: number;
};

export type AsyncServerTelegramConfig = Record<string, AsyncServerTelegramBotConfig>;

export type AsyncServerConfig = {
  host?: string;
  port?: number;
  authToken?: string;
  maxSessions?: number;
  telegram?: AsyncServerTelegramConfig;
};

export type AsyncProjectConfig = {
  repo: string;
  ref?: string;
  workspaceRoot?: string;
  workingDirectory?: string;
  description?: string;
  bootstrapCommands?: string[];
  backgroundBootstrapCommands?: string[];
  persona?: string;
  riskLevel?: RiskLevel;
  sandbox?: boolean;
  noAgentContextFiles?: boolean;
};

export type AsyncConfig = {
  client?: AsyncClientConfig;
};

type ConfigDiagnostics = {
  config: Config;
  errors: string[];
};

const NonEmptyStringSchema = z.string().trim().min(1);
const BooleanSchema = z.boolean();
const AgentContextFilesSchema = z.array(NonEmptyStringSchema);
const ApiKeyProviderSchema = z.string();
const ApiKeysSchema = z.object({}).catchall(z.unknown());
const SandboxSchema = z
  .object({
    image: z.unknown().optional(),
    mountPath: z.unknown().optional(),
    pruneAfterHours: z.unknown().optional(),
    extraDockerArgs: z.unknown().optional(),
    environmentInfo: z.unknown().optional(),
  })
  .passthrough();
const SandboxFieldsSchema = z.object({
  image: NonEmptyStringSchema,
  mountPath: NonEmptyStringSchema,
  pruneAfterHours: z.number().finite().gt(0),
  extraDockerArgs: z.array(z.string().refine((entry) => entry.trim().length > 0)),
  environmentInfo: z.string(),
});
const SubagentsConfigSchema = z
  .object({
    defaultLaunchModels: z.array(z.string()).optional(),
  })
  .passthrough();
const StringRecordSchema = z.object({}).catchall(z.unknown());
const PositiveIntegerSchema = z.number().int().finite().gt(0);
const AsyncClientTargetSchema = z.object({
  url: NonEmptyStringSchema,
  token: NonEmptyStringSchema,
  timeoutMs: PositiveIntegerSchema.optional(),
});

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
  modelResolver: ModelResolver,
): ConfigDiagnostics {
  if (typeof raw !== "object" || raw === null) {
    return { config: {}, errors: [`${sourceLabel}: config must be an object.`] };
  }

  const data = raw as Record<string, unknown>;
  const config: Config = {};
  const errors: string[] = [];

  const apiKeysResult = parseApiKeysConfig(data.apiKeys, sourceLabel);
  assignParsedConfigValue(config, errors, "apiKeys", apiKeysResult.config, apiKeysResult.errors);

  const sandboxResult = parseSandboxConfig(data.sandbox, sourceLabel);
  assignParsedConfigValue(config, errors, "sandbox", sandboxResult.config, sandboxResult.errors);

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

  const bashResult = parseBashCommands(data.bashCommands, sourceLabel);
  assignParsedConfigValue(
    config,
    errors,
    "bashCommands",
    bashResult.commands.length > 0 ? bashResult.commands : undefined,
    bashResult.errors,
  );

  const agentResult = parseAgentContextFiles(data.agentContextFiles, sourceLabel);
  assignParsedConfigValue(
    config,
    errors,
    "agentContextFiles",
    agentResult.paths.length > 0 ? agentResult.paths : undefined,
    agentResult.errors,
  );

  const subagentsResult = parseSubagentsConfig(data.subagents, sourceLabel, modelResolver);
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
    modelResolver,
  );
  assignParsedConfigValue(
    config,
    errors,
    "modelSystemNotices",
    modelSystemNoticesResult.notices,
    modelSystemNoticesResult.errors,
  );

  const asyncResult = parseAsyncConfig(data.async, sourceLabel);
  assignParsedConfigValue(config, errors, "async", asyncResult.config, asyncResult.errors);

  return { config, errors };
}

function parseSandboxConfig(
  raw: unknown,
  sourceLabel: string,
): { config?: SandboxConfig; errors: string[] } {
  if (raw === undefined) {
    return { errors: [] };
  }

  const parsed = SandboxSchema.safeParse(raw);
  if (!parsed.success) {
    return { errors: [`${sourceLabel}: 'sandbox' must be an object.`] };
  }

  const sandboxResult = parseOptionalFields(parsed.data, sourceLabel, [
    ["image", SandboxFieldsSchema.shape.image, "sandbox.image must be a non-empty string."],
    [
      "mountPath",
      SandboxFieldsSchema.shape.mountPath,
      "sandbox.mountPath must be a non-empty string.",
    ],
    [
      "pruneAfterHours",
      SandboxFieldsSchema.shape.pruneAfterHours,
      "sandbox.pruneAfterHours must be a positive number.",
    ],
    [
      "extraDockerArgs",
      SandboxFieldsSchema.shape.extraDockerArgs,
      "sandbox.extraDockerArgs must be a string array.",
    ],
    [
      "environmentInfo",
      SandboxFieldsSchema.shape.environmentInfo,
      "sandbox.environmentInfo must be a string.",
    ],
  ]);

  if (Object.keys(sandboxResult.values).length === 0) {
    return { errors: sandboxResult.errors };
  }

  return { config: sandboxResult.values as SandboxConfig, errors: sandboxResult.errors };
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

function parseAsyncClientTarget(
  raw: unknown,
  sourceLabel: string,
  key: string,
): { config?: AsyncClientTargetConfig; errors: string[] } {
  const parsedRecord = StringRecordSchema.safeParse(raw);
  if (!parsedRecord.success) {
    return { errors: [`${sourceLabel}: async.client.targets.${key} must be an object.`] };
  }

  const parsedTarget = AsyncClientTargetSchema.safeParse(parsedRecord.data);
  if (parsedTarget.success) {
    return { config: parsedTarget.data, errors: [] };
  }

  const errors = new Set<string>();
  for (const issue of parsedTarget.error.issues) {
    switch (issue.path[0]) {
      case "url":
        errors.add(`${sourceLabel}: async.client.targets.${key}.url must be a non-empty string.`);
        break;
      case "token":
        errors.add(`${sourceLabel}: async.client.targets.${key}.token must be a non-empty string.`);
        break;
      case "timeoutMs":
        errors.add(
          `${sourceLabel}: async.client.targets.${key}.timeoutMs must be a positive integer.`,
        );
        break;
      default:
        break;
    }
  }

  return { errors: [...errors] };
}

function parseAsyncClientConfig(
  raw: unknown,
  sourceLabel: string,
): { config?: AsyncClientConfig; errors: string[] } {
  if (raw === undefined) {
    return { errors: [] };
  }

  const parsedRecord = StringRecordSchema.safeParse(raw);
  if (!parsedRecord.success) {
    return { errors: [`${sourceLabel}: async.client must be an object.`] };
  }

  const data = parsedRecord.data;
  const config: AsyncClientConfig = {};
  const scalarResult = parseOptionalFields(data, sourceLabel, [
    [
      "defaultTarget",
      NonEmptyStringSchema,
      "async.client.defaultTarget must be a non-empty string.",
    ],
    [
      "defaultProjectId",
      NonEmptyStringSchema,
      "async.client.defaultProjectId must be a non-empty string.",
    ],
  ]);
  Object.assign(config as Record<string, unknown>, scalarResult.values);

  const errors: string[] = [...scalarResult.errors];

  if (data.targets !== undefined) {
    const parsedTargetsRecord = StringRecordSchema.safeParse(data.targets);
    if (!parsedTargetsRecord.success) {
      errors.push(`${sourceLabel}: async.client.targets must be an object.`);
    } else {
      const targets: Record<string, AsyncClientTargetConfig> = {};
      for (const [key, value] of Object.entries(parsedTargetsRecord.data)) {
        const parsedTargetKey = NonEmptyStringSchema.safeParse(key);
        if (!parsedTargetKey.success) {
          errors.push(`${sourceLabel}: async.client.targets keys must be non-empty.`);
          continue;
        }

        const parsedTarget = parseAsyncClientTarget(value, sourceLabel, key);
        if (parsedTarget.config) {
          targets[key] = parsedTarget.config;
        }
        errors.push(...parsedTarget.errors);
      }

      if (Object.keys(targets).length > 0) {
        config.targets = targets;
      }
    }
  }

  if (Object.keys(config).length === 0) {
    return { errors };
  }

  return { config, errors };
}

function parseAsyncConfig(
  raw: unknown,
  sourceLabel: string,
): { config?: AsyncConfig; errors: string[] } {
  if (raw === undefined) {
    return { errors: [] };
  }

  const parsedRecord = StringRecordSchema.safeParse(raw);
  if (!parsedRecord.success) {
    return { errors: [`${sourceLabel}: 'async' must be an object.`] };
  }

  const data = parsedRecord.data;
  const config: AsyncConfig = {};
  const errors: string[] = [];

  const clientResult = parseAsyncClientConfig(data.client, sourceLabel);
  if (clientResult.config) {
    config.client = clientResult.config;
  }
  errors.push(...clientResult.errors);

  const movedAsyncFields = ["server", "projects"] as const;
  for (const field of movedAsyncFields) {
    if (data[field] === undefined) {
      continue;
    }
    errors.push(
      `${sourceLabel}: async.${field} was moved to daemon config file. use 'tau async daemon --config-file <path>'.`,
    );
  }

  if (Object.keys(config).length === 0) {
    return { errors };
  }

  return { config, errors };
}

function loadConfigFile(
  level: ConfigLevel,
  deps: ConfigDeps,
  sourceLabel: string,
  modelResolver: ModelResolver,
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

    const validated = validateConfigData(parsed.data, sourceLabel, modelResolver);
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

function mergeAsyncClientConfig(
  target: AsyncClientConfig | undefined,
  overlay: AsyncClientConfig | undefined,
): AsyncClientConfig | undefined {
  if (!target && !overlay) {
    return undefined;
  }

  const merged: AsyncClientConfig = {
    ...(target ?? {}),
  };

  if (overlay?.defaultTarget !== undefined) {
    merged.defaultTarget = overlay.defaultTarget;
  }

  if (overlay?.defaultProjectId !== undefined) {
    merged.defaultProjectId = overlay.defaultProjectId;
  }

  if (target?.targets || overlay?.targets) {
    const targets = new Map<string, AsyncClientTargetConfig>();

    for (const [key, value] of Object.entries(target?.targets ?? {})) {
      targets.set(key, { ...value });
    }

    for (const [key, value] of Object.entries(overlay?.targets ?? {})) {
      targets.set(key, mergeOptionalObject(targets.get(key), value) ?? value);
    }

    if (targets.size > 0) {
      merged.targets = Object.fromEntries(targets.entries());
    }
  }

  return merged;
}

function mergeAsyncConfig(
  target: AsyncConfig | undefined,
  overlay: AsyncConfig | undefined,
): AsyncConfig | undefined {
  if (!target && !overlay) {
    return undefined;
  }

  const merged: AsyncConfig = {
    ...(target ?? {}),
    ...(overlay ?? {}),
    client: mergeAsyncClientConfig(target?.client, overlay?.client),
  };

  return merged;
}

function resolveAgentContextPaths(level: ConfigLevel, rawPaths: string[]): string[] {
  const root = level.levelRoot;
  return rawPaths.map((entry) => resolve(root, entry));
}

function resolveBashCommands(level: ConfigLevel, commands: BashCommand[]): BashCommand[] {
  const root = level.levelRoot;
  return commands.map((cmd) => ({ ...cmd, cwd: root }));
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
  let sandbox: SandboxConfig | undefined;
  let subagents: Config["subagents"] | undefined;
  let modelSystemNotices: Config["modelSystemNotices"] | undefined;
  let asyncConfig: AsyncConfig | undefined;
  const bashCommands = new Map<string, BashCommand>();
  const agentContextFiles: string[] = [];

  for (let i = 0; i < levels.length; i += 1) {
    const level = levels[i]!;
    const config = configs[i] ?? {};

    apiKeys = mergeOptionalObject(apiKeys, config.apiKeys);
    sandbox = mergeOptionalObject(sandbox, config.sandbox);
    subagents = mergeSubagentsConfig(subagents, config.subagents);
    modelSystemNotices = mergeOptionalObject(modelSystemNotices, config.modelSystemNotices);
    asyncConfig = mergeAsyncConfig(asyncConfig, config.async);

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

    if (config.bashCommands) {
      for (const cmd of resolveBashCommands(level, config.bashCommands)) {
        bashCommands.set(cmd.id.toLowerCase(), cmd);
      }
    }

    if (config.agentContextFiles) {
      agentContextFiles.push(...resolveAgentContextPaths(level, config.agentContextFiles));
    }
  }

  if (apiKeys && Object.keys(apiKeys).length > 0) {
    merged.apiKeys = apiKeys;
  }

  if (sandbox && Object.keys(sandbox).length > 0) {
    merged.sandbox = sandbox;
  }

  if (subagents && Object.keys(subagents).length > 0) {
    merged.subagents = subagents;
  }

  if (modelSystemNotices && Object.keys(modelSystemNotices).length > 0) {
    merged.modelSystemNotices = modelSystemNotices;
  }

  if (asyncConfig && Object.keys(asyncConfig).length > 0) {
    merged.async = asyncConfig;
  }

  if (bashCommands.size > 0) {
    merged.bashCommands = Array.from(bashCommands.values());
  }

  if (agentContextFiles.length > 0) {
    merged.agentContextFiles = dedupePaths(agentContextFiles);
  }

  return merged;
}

export function loadConfigWithDiagnostics(
  cwd?: string,
  deps?: ConfigDeps,
): { config: Config; errors: string[] } {
  const resolvedDeps = deps ?? createDefaultConfigDeps();
  const resolvedCwd = cwd ?? resolvedDeps.env.cwd();
  const levels = resolveConfigLevels(resolvedDeps, { cwd: resolvedCwd });
  const modelResolverResult = loadModelResolver({
    deps: resolvedDeps,
    levels,
    cwd: resolvedCwd,
  });

  const results = levels.map((level) =>
    loadConfigFile(level, resolvedDeps, level.configPath, modelResolverResult.resolveModel),
  );

  return {
    config: mergeConfigLevels(
      levels,
      results.map((result) => result.config),
    ),
    errors: [...modelResolverResult.errors, ...results.flatMap((result) => result.errors)],
  };
}

export function loadConfig(cwd?: string, deps?: ConfigDeps): Config {
  return loadConfigWithDiagnostics(cwd, deps).config;
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

export function getMistralApiKey(config: Config, env?: NodeJS.ProcessEnv): string | undefined {
  const envKey = getTrimmedEnvValue("MISTRAL_API_KEY", env);
  if (envKey) {
    return envKey;
  }

  const configKey = config.apiKeys?.mistral?.trim();
  return configKey || undefined;
}
