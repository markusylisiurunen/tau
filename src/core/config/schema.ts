import { resolve } from "node:path";
import type { KnownProvider } from "@mariozechner/pi-ai";
import { parseSubagentLaunchModelList } from "../subagents/launch_model.js";
import { type RiskLevel, RiskLevelSchema } from "../types.js";
import { isRecord } from "../utils/type_guards.js";
import type { BashCommand } from "./bash_commands.js";
import { parseBashCommands } from "./bash_commands.js";
import type { ConfigDeps } from "./deps.js";
import { createDefaultConfigDeps } from "./deps.js";
import type { ConfigLevel } from "./paths.js";
import { resolveConfigLevels } from "./paths.js";
import { getVirtualConfigDefaults } from "./virtual_defaults.js";

export interface Config {
  apiKeys?: {
    anthropic?: string;
    google?: string;
    openai?: string;
    parallel?: string;
    mistral?: string;
  };
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
  targets?: Record<string, AsyncClientTargetConfig>;
};

export type AsyncServerTelegramConfig = {
  botToken?: string;
  allowedUserIds?: number[];
  allowedChatIds?: number[];
  defaultProjectId?: string;
  pollIntervalMs?: number;
  requestTimeoutSeconds?: number;
};

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
  bootstrapCommands?: string[];
  persona?: string;
  riskLevel?: RiskLevel;
  sandbox?: boolean;
  noAgentContextFiles?: boolean;
};

export type AsyncConfig = {
  client?: AsyncClientConfig;
  server?: AsyncServerConfig;
  projects?: Record<string, AsyncProjectConfig>;
};

type ConfigDiagnostics = {
  config: Config;
  errors: string[];
};

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

function validateConfigData(raw: unknown, sourceLabel: string): ConfigDiagnostics {
  if (typeof raw !== "object" || raw === null) {
    return { config: {}, errors: [`${sourceLabel}: config must be an object.`] };
  }

  const data = raw as Record<string, unknown>;
  const config: Config = {};
  const errors: string[] = [];

  if (data.apiKeys !== undefined) {
    if (typeof data.apiKeys !== "object" || data.apiKeys === null) {
      errors.push(`${sourceLabel}: 'apiKeys' must be an object.`);
    } else {
      const apiKeys: Config["apiKeys"] = {};
      const keys = data.apiKeys as Record<string, unknown>;
      const providers = ["anthropic", "google", "openai", "parallel", "mistral"] as const;
      for (const provider of providers) {
        const value = keys[provider];
        if (value === undefined) continue;
        if (typeof value !== "string") {
          errors.push(`${sourceLabel}: apiKeys.${provider} must be a string.`);
          continue;
        }
        apiKeys[provider] = value;
      }
      if (Object.keys(apiKeys).length > 0) {
        config.apiKeys = apiKeys;
      }
    }
  }

  const sandboxResult = parseSandboxConfig(data.sandbox, sourceLabel);
  if (sandboxResult.config) {
    config.sandbox = sandboxResult.config;
  }
  errors.push(...sandboxResult.errors);

  if (data.defaultPersona !== undefined) {
    if (typeof data.defaultPersona === "string") {
      config.defaultPersona = data.defaultPersona;
    } else {
      errors.push(`${sourceLabel}: 'defaultPersona' must be a string.`);
    }
  }

  if (data.defaultRisk !== undefined) {
    const parsed = RiskLevelSchema.safeParse(data.defaultRisk);
    if (parsed.success) {
      config.defaultRisk = parsed.data;
    } else {
      errors.push(`${sourceLabel}: 'defaultRisk' must be a valid risk level.`);
    }
  }

  if (data.disableBuiltinPersonas !== undefined) {
    if (typeof data.disableBuiltinPersonas === "boolean") {
      config.disableBuiltinPersonas = data.disableBuiltinPersonas;
    } else {
      errors.push(`${sourceLabel}: 'disableBuiltinPersonas' must be a boolean.`);
    }
  }

  if (data.disableBuiltinThemes !== undefined) {
    if (typeof data.disableBuiltinThemes === "boolean") {
      config.disableBuiltinThemes = data.disableBuiltinThemes;
    } else {
      errors.push(`${sourceLabel}: 'disableBuiltinThemes' must be a boolean.`);
    }
  }

  if (data.defaultTheme !== undefined) {
    if (typeof data.defaultTheme === "string") {
      config.defaultTheme = data.defaultTheme;
    } else {
      errors.push(`${sourceLabel}: 'defaultTheme' must be a string.`);
    }
  }

  const bashResult = parseBashCommands(data.bashCommands, sourceLabel);
  if (bashResult.commands.length > 0) {
    config.bashCommands = bashResult.commands;
  }
  errors.push(...bashResult.errors);

  const agentResult = parseAgentContextFiles(data.agentContextFiles, sourceLabel);
  if (agentResult.paths.length > 0) {
    config.agentContextFiles = agentResult.paths;
  }
  errors.push(...agentResult.errors);

  const subagentsResult = parseSubagentsConfig(data.subagents, sourceLabel);
  if (subagentsResult.config) {
    config.subagents = subagentsResult.config;
  }
  errors.push(...subagentsResult.errors);

  const asyncResult = parseAsyncConfig(data.async, sourceLabel);
  if (asyncResult.config) {
    config.async = asyncResult.config;
  }
  errors.push(...asyncResult.errors);

  return { config, errors };
}

function parseSandboxConfig(
  raw: unknown,
  sourceLabel: string,
): { config?: SandboxConfig; errors: string[] } {
  if (raw === undefined) {
    return { errors: [] };
  }

  if (typeof raw !== "object" || raw === null) {
    return { errors: [`${sourceLabel}: 'sandbox' must be an object.`] };
  }

  const data = raw as Record<string, unknown>;
  const errors: string[] = [];
  const sandbox: SandboxConfig = {};

  if (data.image !== undefined) {
    if (typeof data.image === "string" && data.image.trim()) {
      sandbox.image = data.image.trim();
    } else {
      errors.push(`${sourceLabel}: sandbox.image must be a non-empty string.`);
    }
  }

  if (data.mountPath !== undefined) {
    if (typeof data.mountPath === "string" && data.mountPath.trim()) {
      sandbox.mountPath = data.mountPath.trim();
    } else {
      errors.push(`${sourceLabel}: sandbox.mountPath must be a non-empty string.`);
    }
  }

  if (data.pruneAfterHours !== undefined) {
    if (
      typeof data.pruneAfterHours === "number" &&
      Number.isFinite(data.pruneAfterHours) &&
      data.pruneAfterHours > 0
    ) {
      sandbox.pruneAfterHours = data.pruneAfterHours;
    } else {
      errors.push(`${sourceLabel}: sandbox.pruneAfterHours must be a positive number.`);
    }
  }

  if (data.extraDockerArgs !== undefined) {
    if (Array.isArray(data.extraDockerArgs)) {
      const args: string[] = [];
      let invalid = false;
      for (const entry of data.extraDockerArgs) {
        if (typeof entry !== "string" || !entry.trim()) {
          invalid = true;
          continue;
        }
        args.push(entry);
      }
      if (invalid) {
        errors.push(`${sourceLabel}: sandbox.extraDockerArgs must be a string array.`);
      } else {
        sandbox.extraDockerArgs = args;
      }
    } else {
      errors.push(`${sourceLabel}: sandbox.extraDockerArgs must be a string array.`);
    }
  }

  if (data.environmentInfo !== undefined) {
    if (typeof data.environmentInfo === "string") {
      sandbox.environmentInfo = data.environmentInfo;
    } else {
      errors.push(`${sourceLabel}: sandbox.environmentInfo must be a string.`);
    }
  }

  if (Object.keys(sandbox).length === 0) {
    return { errors };
  }

  return { config: sandbox, errors };
}

function parseAgentContextFiles(
  raw: unknown,
  sourceLabel: string,
): { paths: string[]; errors: string[] } {
  if (raw === undefined) {
    return { paths: [], errors: [] };
  }

  const list = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : undefined;

  if (!list) {
    return {
      paths: [],
      errors: [`${sourceLabel}: 'agentContextFiles' must be a string or string array.`],
    };
  }

  const cleaned = list
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (cleaned.length === 0) {
    return {
      paths: [],
      errors: [`${sourceLabel}: 'agentContextFiles' must be a string or string array.`],
    };
  }

  return { paths: cleaned, errors: [] };
}

function parseSubagentsConfig(
  raw: unknown,
  sourceLabel: string,
): { config?: Config["subagents"]; errors: string[] } {
  if (raw === undefined) {
    return { errors: [] };
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { errors: [`${sourceLabel}: 'subagents' must be an object.`] };
  }

  const data = raw as Record<string, unknown>;
  const config: NonNullable<Config["subagents"]> = {};
  const errors: string[] = [];

  if ("defaultLaunchModels" in data) {
    const launchModelsResult = parseSubagentLaunchModelList(data.defaultLaunchModels);
    if (launchModelsResult.error) {
      errors.push(
        `${sourceLabel}: subagents.defaultLaunchModels ${launchModelsResult.error}. expected <provider>/<model>:<effort>.`,
      );
    } else {
      config.defaultLaunchModels = launchModelsResult.launchModels ?? [];
    }
  }

  if (Object.keys(config).length === 0) {
    return { errors };
  }

  return { config, errors };
}

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && Number.isFinite(value) && value > 0
  );
}

function parsePositiveIntegerField(value: unknown, options?: { max?: number }): number | undefined {
  if (!isPositiveInteger(value)) {
    return undefined;
  }

  if (options?.max !== undefined && value > options.max) {
    return undefined;
  }

  return value;
}

function parseAsyncIdList(
  raw: unknown,
  fieldPath: string,
  sourceLabel: string,
): { values?: number[]; errors: string[] } {
  if (!Array.isArray(raw)) {
    return { errors: [`${sourceLabel}: ${fieldPath} must be an array of integers.`] };
  }

  const values: number[] = [];
  for (const entry of raw) {
    if (typeof entry !== "number" || !Number.isFinite(entry) || !Number.isInteger(entry)) {
      return { errors: [`${sourceLabel}: ${fieldPath} must be an array of integers.`] };
    }
    values.push(entry);
  }

  return { values, errors: [] };
}

function parseAsyncTelegramConfig(
  raw: unknown,
  sourceLabel: string,
): { config?: AsyncServerTelegramConfig; errors: string[] } {
  if (raw === undefined) {
    return { errors: [] };
  }

  if (!isRecord(raw)) {
    return { errors: [`${sourceLabel}: async.server.telegram must be an object.`] };
  }

  const data = raw as Record<string, unknown>;
  const config: AsyncServerTelegramConfig = {};
  const errors: string[] = [];

  if (data.botToken !== undefined) {
    if (typeof data.botToken === "string" && data.botToken.trim()) {
      config.botToken = data.botToken.trim();
    } else {
      errors.push(`${sourceLabel}: async.server.telegram.botToken must be a non-empty string.`);
    }
  }

  if (data.allowedUserIds !== undefined) {
    const parsed = parseAsyncIdList(
      data.allowedUserIds,
      "async.server.telegram.allowedUserIds",
      sourceLabel,
    );
    if (parsed.values) {
      config.allowedUserIds = parsed.values;
    }
    errors.push(...parsed.errors);
  }

  if (data.allowedChatIds !== undefined) {
    const parsed = parseAsyncIdList(
      data.allowedChatIds,
      "async.server.telegram.allowedChatIds",
      sourceLabel,
    );
    if (parsed.values) {
      config.allowedChatIds = parsed.values;
    }
    errors.push(...parsed.errors);
  }

  if (data.defaultProjectId !== undefined) {
    if (typeof data.defaultProjectId === "string" && data.defaultProjectId.trim()) {
      config.defaultProjectId = data.defaultProjectId.trim();
    } else {
      errors.push(
        `${sourceLabel}: async.server.telegram.defaultProjectId must be a non-empty string.`,
      );
    }
  }

  if (data.pollIntervalMs !== undefined) {
    const parsed = parsePositiveIntegerField(data.pollIntervalMs);
    if (parsed !== undefined) {
      config.pollIntervalMs = parsed;
    } else {
      errors.push(
        `${sourceLabel}: async.server.telegram.pollIntervalMs must be a positive integer.`,
      );
    }
  }

  if (data.requestTimeoutSeconds !== undefined) {
    const parsed = parsePositiveIntegerField(data.requestTimeoutSeconds);
    if (parsed !== undefined) {
      config.requestTimeoutSeconds = parsed;
    } else {
      errors.push(
        `${sourceLabel}: async.server.telegram.requestTimeoutSeconds must be a positive integer.`,
      );
    }
  }

  if (Object.keys(config).length === 0) {
    return { errors };
  }

  return { config, errors };
}

function parseAsyncServerConfig(
  raw: unknown,
  sourceLabel: string,
): { config?: AsyncServerConfig; errors: string[] } {
  if (raw === undefined) {
    return { errors: [] };
  }

  if (!isRecord(raw)) {
    return { errors: [`${sourceLabel}: async.server must be an object.`] };
  }

  const data = raw as Record<string, unknown>;
  const config: AsyncServerConfig = {};
  const errors: string[] = [];

  if (data.host !== undefined) {
    if (typeof data.host === "string" && data.host.trim()) {
      config.host = data.host.trim();
    } else {
      errors.push(`${sourceLabel}: async.server.host must be a non-empty string.`);
    }
  }

  if (data.port !== undefined) {
    const parsed = parsePositiveIntegerField(data.port, { max: 65535 });
    if (parsed !== undefined) {
      config.port = parsed;
    } else {
      errors.push(`${sourceLabel}: async.server.port must be a positive integer <= 65535.`);
    }
  }

  if (data.authToken !== undefined) {
    if (typeof data.authToken === "string" && data.authToken.trim()) {
      config.authToken = data.authToken.trim();
    } else {
      errors.push(`${sourceLabel}: async.server.authToken must be a non-empty string.`);
    }
  }

  if (data.maxSessions !== undefined) {
    const parsed = parsePositiveIntegerField(data.maxSessions);
    if (parsed !== undefined) {
      config.maxSessions = parsed;
    } else {
      errors.push(`${sourceLabel}: async.server.maxSessions must be a positive integer.`);
    }
  }

  const telegramResult = parseAsyncTelegramConfig(data.telegram, sourceLabel);
  if (telegramResult.config) {
    config.telegram = telegramResult.config;
  }
  errors.push(...telegramResult.errors);

  if (Object.keys(config).length === 0) {
    return { errors };
  }

  return { config, errors };
}

function parseAsyncClientTarget(
  raw: unknown,
  sourceLabel: string,
  key: string,
): { config?: AsyncClientTargetConfig; errors: string[] } {
  if (!isRecord(raw)) {
    return { errors: [`${sourceLabel}: async.client.targets.${key} must be an object.`] };
  }

  const data = raw as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof data.url !== "string" || !data.url.trim()) {
    errors.push(`${sourceLabel}: async.client.targets.${key}.url must be a non-empty string.`);
  }

  if (typeof data.token !== "string" || !data.token.trim()) {
    errors.push(`${sourceLabel}: async.client.targets.${key}.token must be a non-empty string.`);
  }

  const config: AsyncClientTargetConfig = {
    url: typeof data.url === "string" ? data.url.trim() : "",
    token: typeof data.token === "string" ? data.token.trim() : "",
  };

  if (data.timeoutMs !== undefined) {
    const parsed = parsePositiveIntegerField(data.timeoutMs);
    if (parsed !== undefined) {
      config.timeoutMs = parsed;
    } else {
      errors.push(
        `${sourceLabel}: async.client.targets.${key}.timeoutMs must be a positive integer.`,
      );
    }
  }

  if (errors.length > 0) {
    return { errors };
  }

  return { config, errors: [] };
}

function parseAsyncClientConfig(
  raw: unknown,
  sourceLabel: string,
): { config?: AsyncClientConfig; errors: string[] } {
  if (raw === undefined) {
    return { errors: [] };
  }

  if (!isRecord(raw)) {
    return { errors: [`${sourceLabel}: async.client must be an object.`] };
  }

  const data = raw as Record<string, unknown>;
  const errors: string[] = [];
  const config: AsyncClientConfig = {};

  if (data.defaultTarget !== undefined) {
    if (typeof data.defaultTarget === "string" && data.defaultTarget.trim()) {
      config.defaultTarget = data.defaultTarget.trim();
    } else {
      errors.push(`${sourceLabel}: async.client.defaultTarget must be a non-empty string.`);
    }
  }

  if (data.targets !== undefined) {
    if (!isRecord(data.targets)) {
      errors.push(`${sourceLabel}: async.client.targets must be an object.`);
    } else {
      const targets: Record<string, AsyncClientTargetConfig> = {};
      for (const [key, value] of Object.entries(data.targets)) {
        if (!key.trim()) {
          errors.push(`${sourceLabel}: async.client.targets keys must be non-empty.`);
          continue;
        }
        const parsed = parseAsyncClientTarget(value, sourceLabel, key);
        if (parsed.config) {
          targets[key] = parsed.config;
        }
        errors.push(...parsed.errors);
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

function parseBootstrapCommands(
  raw: unknown,
  sourceLabel: string,
  projectId: string,
): { commands?: string[]; errors: string[] } {
  if (!Array.isArray(raw)) {
    return {
      errors: [
        `${sourceLabel}: async.projects.${projectId}.bootstrapCommands must be a non-empty string array.`,
      ],
    };
  }

  if (raw.length === 0) {
    return {
      errors: [
        `${sourceLabel}: async.projects.${projectId}.bootstrapCommands must be a non-empty string array.`,
      ],
    };
  }

  const commands: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !entry.trim()) {
      return {
        errors: [
          `${sourceLabel}: async.projects.${projectId}.bootstrapCommands must be a non-empty string array.`,
        ],
      };
    }
    commands.push(entry);
  }

  return { commands, errors: [] };
}

function parseAsyncProject(
  raw: unknown,
  sourceLabel: string,
  projectId: string,
): { config?: AsyncProjectConfig; errors: string[] } {
  if (!isRecord(raw)) {
    return { errors: [`${sourceLabel}: async.projects.${projectId} must be an object.`] };
  }

  const data = raw as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof data.repo !== "string" || !data.repo.trim()) {
    errors.push(`${sourceLabel}: async.projects.${projectId}.repo must be a non-empty string.`);
  }

  const config: AsyncProjectConfig = {
    repo: typeof data.repo === "string" ? data.repo.trim() : "",
  };

  if (data.ref !== undefined) {
    if (typeof data.ref === "string" && data.ref.trim()) {
      config.ref = data.ref.trim();
    } else {
      errors.push(`${sourceLabel}: async.projects.${projectId}.ref must be a non-empty string.`);
    }
  }

  if (data.workspaceRoot !== undefined) {
    if (typeof data.workspaceRoot === "string" && data.workspaceRoot.trim()) {
      config.workspaceRoot = data.workspaceRoot.trim();
    } else {
      errors.push(
        `${sourceLabel}: async.projects.${projectId}.workspaceRoot must be a non-empty string.`,
      );
    }
  }

  if (data.bootstrapCommands !== undefined) {
    const parsed = parseBootstrapCommands(data.bootstrapCommands, sourceLabel, projectId);
    if (parsed.commands) {
      config.bootstrapCommands = parsed.commands;
    }
    errors.push(...parsed.errors);
  }

  if (data.persona !== undefined) {
    if (typeof data.persona === "string" && data.persona.trim()) {
      config.persona = data.persona.trim();
    } else {
      errors.push(
        `${sourceLabel}: async.projects.${projectId}.persona must be a non-empty string.`,
      );
    }
  }

  if (data.riskLevel !== undefined) {
    const parsed = RiskLevelSchema.safeParse(data.riskLevel);
    if (parsed.success) {
      config.riskLevel = parsed.data;
    } else {
      errors.push(
        `${sourceLabel}: async.projects.${projectId}.riskLevel must be a valid risk level.`,
      );
    }
  }

  if (data.sandbox !== undefined) {
    if (typeof data.sandbox === "boolean") {
      config.sandbox = data.sandbox;
    } else {
      errors.push(`${sourceLabel}: async.projects.${projectId}.sandbox must be a boolean.`);
    }
  }

  if (data.noAgentContextFiles !== undefined) {
    if (typeof data.noAgentContextFiles === "boolean") {
      config.noAgentContextFiles = data.noAgentContextFiles;
    } else {
      errors.push(
        `${sourceLabel}: async.projects.${projectId}.noAgentContextFiles must be a boolean.`,
      );
    }
  }

  if (errors.length > 0) {
    return { errors };
  }

  return { config, errors };
}

function parseAsyncProjects(
  raw: unknown,
  sourceLabel: string,
): { projects?: Record<string, AsyncProjectConfig>; errors: string[] } {
  if (raw === undefined) {
    return { errors: [] };
  }

  if (!isRecord(raw)) {
    return { errors: [`${sourceLabel}: async.projects must be an object.`] };
  }

  const projects: Record<string, AsyncProjectConfig> = {};
  const errors: string[] = [];

  for (const [projectId, value] of Object.entries(raw)) {
    if (!projectId.trim()) {
      errors.push(`${sourceLabel}: async.projects keys must be non-empty.`);
      continue;
    }

    const parsed = parseAsyncProject(value, sourceLabel, projectId);
    if (parsed.config) {
      projects[projectId] = parsed.config;
    }
    errors.push(...parsed.errors);
  }

  if (Object.keys(projects).length === 0) {
    return { errors };
  }

  return { projects, errors };
}

function parseAsyncConfig(
  raw: unknown,
  sourceLabel: string,
): { config?: AsyncConfig; errors: string[] } {
  if (raw === undefined) {
    return { errors: [] };
  }

  if (!isRecord(raw)) {
    return { errors: [`${sourceLabel}: 'async' must be an object.`] };
  }

  const data = raw as Record<string, unknown>;
  const config: AsyncConfig = {};
  const errors: string[] = [];

  const clientResult = parseAsyncClientConfig(data.client, sourceLabel);
  if (clientResult.config) {
    config.client = clientResult.config;
  }
  errors.push(...clientResult.errors);

  const serverResult = parseAsyncServerConfig(data.server, sourceLabel);
  if (serverResult.config) {
    config.server = serverResult.config;
  }
  errors.push(...serverResult.errors);

  const projectsResult = parseAsyncProjects(data.projects, sourceLabel);
  if (projectsResult.projects) {
    config.projects = projectsResult.projects;
  }
  errors.push(...projectsResult.errors);

  if (Object.keys(config).length === 0) {
    return { errors };
  }

  return { config, errors };
}

function loadConfigFile(
  level: ConfigLevel,
  deps: ConfigDeps,
  sourceLabel: string,
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

    const validated = validateConfigData(parsed.data, sourceLabel);
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

function mergeApiKeys(
  target: Config["apiKeys"] | undefined,
  overlay: Config["apiKeys"] | undefined,
): Config["apiKeys"] | undefined {
  if (!target && !overlay) {
    return undefined;
  }

  return {
    ...(target ?? {}),
    ...(overlay ?? {}),
  };
}

function mergeSandboxConfig(
  target: SandboxConfig | undefined,
  overlay: SandboxConfig | undefined,
): SandboxConfig | undefined {
  if (!target && !overlay) {
    return undefined;
  }

  return {
    ...(target ?? {}),
    ...(overlay ?? {}),
  };
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

function mergeAsyncClientTarget(
  target: AsyncClientTargetConfig | undefined,
  overlay: AsyncClientTargetConfig | undefined,
): AsyncClientTargetConfig | undefined {
  if (!target && !overlay) {
    return undefined;
  }

  return {
    ...(target ?? {}),
    ...(overlay ?? {}),
  } as AsyncClientTargetConfig;
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

  if (target?.targets || overlay?.targets) {
    const targets = new Map<string, AsyncClientTargetConfig>();

    for (const [key, value] of Object.entries(target?.targets ?? {})) {
      targets.set(key, { ...value });
    }

    for (const [key, value] of Object.entries(overlay?.targets ?? {})) {
      targets.set(key, mergeAsyncClientTarget(targets.get(key), value) ?? value);
    }

    if (targets.size > 0) {
      merged.targets = Object.fromEntries(targets.entries());
    }
  }

  return merged;
}

function mergeAsyncServerTelegramConfig(
  target: AsyncServerTelegramConfig | undefined,
  overlay: AsyncServerTelegramConfig | undefined,
): AsyncServerTelegramConfig | undefined {
  if (!target && !overlay) {
    return undefined;
  }

  const merged: AsyncServerTelegramConfig = {
    ...(target ?? {}),
    ...(overlay ?? {}),
  };

  if (overlay?.allowedUserIds !== undefined) {
    merged.allowedUserIds = [...overlay.allowedUserIds];
  }

  if (overlay?.allowedChatIds !== undefined) {
    merged.allowedChatIds = [...overlay.allowedChatIds];
  }

  return merged;
}

function mergeAsyncServerConfig(
  target: AsyncServerConfig | undefined,
  overlay: AsyncServerConfig | undefined,
): AsyncServerConfig | undefined {
  if (!target && !overlay) {
    return undefined;
  }

  return {
    ...(target ?? {}),
    ...(overlay ?? {}),
    telegram: mergeAsyncServerTelegramConfig(target?.telegram, overlay?.telegram),
  };
}

function mergeAsyncProjectConfig(
  target: AsyncProjectConfig | undefined,
  overlay: AsyncProjectConfig | undefined,
): AsyncProjectConfig | undefined {
  if (!target && !overlay) {
    return undefined;
  }

  const merged: AsyncProjectConfig = {
    ...(target ?? {}),
    ...(overlay ?? {}),
  } as AsyncProjectConfig;

  if (overlay?.bootstrapCommands !== undefined) {
    merged.bootstrapCommands = [...overlay.bootstrapCommands];
  }

  return merged;
}

function mergeAsyncProjects(
  target: Record<string, AsyncProjectConfig> | undefined,
  overlay: Record<string, AsyncProjectConfig> | undefined,
): Record<string, AsyncProjectConfig> | undefined {
  if (!target && !overlay) {
    return undefined;
  }

  const projects = new Map<string, AsyncProjectConfig>();

  for (const [key, value] of Object.entries(target ?? {})) {
    projects.set(key, { ...value });
  }

  for (const [key, value] of Object.entries(overlay ?? {})) {
    projects.set(key, mergeAsyncProjectConfig(projects.get(key), value) ?? value);
  }

  if (projects.size === 0) {
    return undefined;
  }

  return Object.fromEntries(projects.entries());
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
    server: mergeAsyncServerConfig(target?.server, overlay?.server),
    projects: mergeAsyncProjects(target?.projects, overlay?.projects),
  };

  return merged;
}

function resolveAsyncProjectPaths(
  level: ConfigLevel,
  projects: Record<string, AsyncProjectConfig>,
) {
  const root = level.levelRoot;
  const resolvedProjects: Record<string, AsyncProjectConfig> = {};

  for (const [projectId, project] of Object.entries(projects)) {
    resolvedProjects[projectId] = {
      ...project,
      ...(project.workspaceRoot !== undefined
        ? { workspaceRoot: resolve(root, project.workspaceRoot) }
        : {}),
    };
  }

  return resolvedProjects;
}

function resolveAsyncConfig(level: ConfigLevel, config: AsyncConfig): AsyncConfig {
  return {
    ...config,
    ...(config.client
      ? {
          client: {
            ...config.client,
            ...(config.client.targets
              ? {
                  targets: Object.fromEntries(
                    Object.entries(config.client.targets).map(([key, value]) => [
                      key,
                      { ...value },
                    ]),
                  ),
                }
              : {}),
          },
        }
      : {}),
    ...(config.server
      ? {
          server: {
            ...config.server,
            ...(config.server.telegram
              ? {
                  telegram: {
                    ...config.server.telegram,
                    ...(config.server.telegram.allowedUserIds
                      ? { allowedUserIds: [...config.server.telegram.allowedUserIds] }
                      : {}),
                    ...(config.server.telegram.allowedChatIds
                      ? { allowedChatIds: [...config.server.telegram.allowedChatIds] }
                      : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(config.projects ? { projects: resolveAsyncProjectPaths(level, config.projects) } : {}),
  };
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
  let asyncConfig: AsyncConfig | undefined;
  const bashCommands = new Map<string, BashCommand>();
  const agentContextFiles: string[] = [];

  for (let i = 0; i < levels.length; i += 1) {
    const level = levels[i]!;
    const config = configs[i] ?? {};

    apiKeys = mergeApiKeys(apiKeys, config.apiKeys);
    sandbox = mergeSandboxConfig(sandbox, config.sandbox);
    subagents = mergeSubagentsConfig(subagents, config.subagents);
    asyncConfig = mergeAsyncConfig(
      asyncConfig,
      config.async ? resolveAsyncConfig(level, config.async) : undefined,
    );

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

  const results = levels.map((level) => loadConfigFile(level, resolvedDeps, level.configPath));

  return {
    config: mergeConfigLevels(
      levels,
      results.map((result) => result.config),
    ),
    errors: results.flatMap((result) => result.errors),
  };
}

export function loadConfig(cwd?: string, deps?: ConfigDeps): Config {
  return loadConfigWithDiagnostics(cwd, deps).config;
}

export function getApiKeyForProvider(config: Config, provider: KnownProvider): string | undefined {
  const apiKeys = config.apiKeys || {};
  switch (provider) {
    case "anthropic":
      return apiKeys.anthropic;
    case "google":
      return apiKeys.google;
    case "openai":
      return apiKeys.openai;
    default:
      return undefined;
  }
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
