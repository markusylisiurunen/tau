import { resolve } from "node:path";
import type { KnownProvider } from "@mariozechner/pi-ai";
import { type RiskLevel, RiskLevelSchema } from "../types.js";
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
}

export type SandboxConfig = {
  image?: string;
  mountPath?: string;
  pruneAfterHours?: number;
  extraDockerArgs?: string[];
  environmentInfo?: string;
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
  const bashCommands = new Map<string, BashCommand>();
  const agentContextFiles: string[] = [];

  for (let i = 0; i < levels.length; i += 1) {
    const level = levels[i]!;
    const config = configs[i] ?? {};

    apiKeys = mergeApiKeys(apiKeys, config.apiKeys);
    sandbox = mergeSandboxConfig(sandbox, config.sandbox);

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
