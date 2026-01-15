import { resolve } from "node:path";
import type { KnownProvider } from "@mariozechner/pi-ai";
import { type RiskLevel, RiskLevelSchema } from "../types.js";
import type { BashCommand } from "./bash_commands.js";
import { parseBashCommands } from "./bash_commands.js";
import type { ConfigDeps } from "./deps.js";
import { createDefaultConfigDeps } from "./deps.js";
import type { ConfigLevel } from "./paths.js";
import { resolveConfigLevels } from "./paths.js";

export interface Config {
  apiKeys?: {
    anthropic?: string;
    google?: string;
    openai?: string;
    parallel?: string;
  };
  defaultPersona?: string;
  defaultRisk?: RiskLevel;
  disableBuiltinPersonas?: boolean;
  theme?: string;
  bashCommands?: BashCommand[];
  agentContextFiles?: string[];
}

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
      const providers = ["anthropic", "google", "openai", "parallel"] as const;
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

  if (data.theme !== undefined) {
    if (typeof data.theme === "string") {
      config.theme = data.theme;
    } else {
      errors.push(`${sourceLabel}: 'theme' must be a string.`);
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

function resolveAgentContextPaths(level: ConfigLevel, rawPaths: string[]): string[] {
  return rawPaths.map((entry) => resolve(level.levelRoot, entry));
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
  const merged: Config = {};
  let apiKeys: Config["apiKeys"] | undefined;
  const bashCommands = new Map<string, BashCommand>();
  const agentContextFiles: string[] = [];

  for (let i = 0; i < levels.length; i += 1) {
    const level = levels[i]!;
    const config = configs[i] ?? {};

    apiKeys = mergeApiKeys(apiKeys, config.apiKeys);

    if (config.defaultPersona !== undefined) {
      merged.defaultPersona = config.defaultPersona;
    }

    if (config.defaultRisk !== undefined) {
      merged.defaultRisk = config.defaultRisk;
    }

    if (config.disableBuiltinPersonas !== undefined) {
      merged.disableBuiltinPersonas = config.disableBuiltinPersonas;
    }

    if (config.theme !== undefined) {
      merged.theme = config.theme;
    }

    if (config.bashCommands) {
      for (const cmd of config.bashCommands) {
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

export function getParallelApiKey(config: Config): string | undefined {
  return config.apiKeys?.parallel;
}

export function isGoogleAuthAvailable(config: Config, deps?: ConfigDeps): boolean {
  const resolvedDeps = deps ?? createDefaultConfigDeps();
  const env = resolvedDeps.env.getEnv();
  return !!(config.apiKeys?.google || env.GEMINI_API_KEY);
}
