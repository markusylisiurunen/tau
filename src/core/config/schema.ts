import type { KnownProvider } from "@mariozechner/pi-ai";
import { z } from "zod";
import { type RiskLevel, RiskLevelSchema } from "../types.js";
import type { ConfigDeps } from "./deps.js";
import { createDefaultConfigDeps } from "./deps.js";
import { resolveConfigPaths } from "./paths.js";

export type ToolDisplayMode = "compact" | "full";

export interface Config {
  apiKeys?: {
    anthropic?: string;
    google?: string;
    openai?: string;
    parallel?: string;
  };
  userPreferences?: string;
  toolDisplayMode?: ToolDisplayMode;
  defaultPersona?: string;
  defaultRisk?: RiskLevel;
  disableBuiltinPersonas?: boolean;
}

const configSchema = z
  .object({
    apiKeys: z
      .object({
        anthropic: z.string().optional().catch(undefined),
        google: z.string().optional().catch(undefined),
        openai: z.string().optional().catch(undefined),
        parallel: z.string().optional().catch(undefined),
      })
      .passthrough()
      .optional()
      .catch(undefined),
    userPreferences: z.string().optional().catch(undefined),
    toolDisplayMode: z.enum(["compact", "full"]).optional().catch(undefined),
    defaultPersona: z.string().optional().catch(undefined),
    defaultRisk: RiskLevelSchema.optional().catch(undefined),
    disableBuiltinPersonas: z.boolean().optional().catch(undefined),
  })
  .passthrough();

type ConfigDiagnostics = {
  config: Config;
  errors: string[];
};

function parseConfigJson(content: string, sourceLabel: string): {
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

  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    return { config: {}, errors: [`${sourceLabel}: config did not match schema.`] };
  }

  return { config: parsed.data as Config, errors: [] };
}

function loadConfigFile(configPath: string, deps: ConfigDeps, sourceLabel: string): ConfigDiagnostics {
  try {
    if (!deps.fs.exists(configPath)) {
      return { config: {}, errors: [] };
    }

    const content = deps.fs.readFile(configPath);
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

function mergeConfig(userConfig: Config, projectConfig: Config): Config {
  // Project config only overrides disableBuiltinPersonas; all other fields come from user config.
  if (projectConfig.disableBuiltinPersonas !== undefined) {
    return { ...userConfig, disableBuiltinPersonas: projectConfig.disableBuiltinPersonas };
  }

  return userConfig;
}

export function loadConfigWithDiagnostics(
  cwd?: string,
  deps?: ConfigDeps,
): { config: Config; errors: string[] } {
  const resolvedDeps = deps ?? createDefaultConfigDeps();
  const resolvedCwd = cwd ?? resolvedDeps.env.cwd();
  const paths = resolveConfigPaths(resolvedDeps, { cwd: resolvedCwd });

  const userResult = loadConfigFile(paths.userConfigPath, resolvedDeps, paths.userConfigPath);
  const projectResult = paths.projectConfigPath
    ? loadConfigFile(paths.projectConfigPath, resolvedDeps, paths.projectConfigPath)
    : { config: {}, errors: [] };

  return {
    config: mergeConfig(userResult.config, projectResult.config),
    errors: [...userResult.errors, ...projectResult.errors],
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
