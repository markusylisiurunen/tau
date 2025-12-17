import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { KnownProvider } from "@mariozechner/pi-ai";
import { z } from "zod";
import { type RiskLevel, RiskLevelSchema } from "./types.js";

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
  })
  .passthrough();

export function loadConfig(): Config {
  const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const configPath = join(configDir, "tau", "config.json");

  try {
    if (!existsSync(configPath)) {
      return {};
    }

    const content = readFileSync(configPath, "utf-8");
    const json = JSON.parse(content) as unknown;
    if (typeof json !== "object" || json === null) return {};

    const parsed = configSchema.safeParse(json);
    return parsed.success ? (parsed.data as Config) : {};
  } catch (err) {
    // If there's an error reading or parsing, silently return empty config
    return {};
  }
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
