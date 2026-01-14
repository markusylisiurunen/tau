import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { KnownProvider } from "@mariozechner/pi-ai";
import { z } from "zod";
import { type RiskLevel, RiskLevelSchema } from "../types.js";
import { getGitRoot } from "../utils/git.js";

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

function loadConfigFile(configPath: string): Config {
  try {
    if (!existsSync(configPath)) {
      return {};
    }

    const content = readFileSync(configPath, "utf-8");
    const json = JSON.parse(content) as unknown;
    if (typeof json !== "object" || json === null) return {};

    const parsed = configSchema.safeParse(json);
    return parsed.success ? (parsed.data as Config) : {};
  } catch {
    // If there's an error reading or parsing, silently return empty config
    return {};
  }
}

function mergeConfig(userConfig: Config, projectConfig: Config): Config {
  // Project config only overrides disableBuiltinPersonas; all other fields come from user config.
  if (projectConfig.disableBuiltinPersonas !== undefined) {
    return { ...userConfig, disableBuiltinPersonas: projectConfig.disableBuiltinPersonas };
  }

  return userConfig;
}

export function loadConfig(cwd: string = process.cwd()): Config {
  const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const userConfigPath = join(configDir, "tau", "config.json");
  const userConfig = loadConfigFile(userConfigPath);

  const repoRoot = getGitRoot(cwd);
  const projectConfigPath = repoRoot ? join(repoRoot, ".tau", "config.json") : undefined;
  const projectConfig = projectConfigPath ? loadConfigFile(projectConfigPath) : {};

  return mergeConfig(userConfig, projectConfig);
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

export function isGoogleAuthAvailable(config: Config): boolean {
  return !!(config.apiKeys?.google || process.env.GEMINI_API_KEY);
}
