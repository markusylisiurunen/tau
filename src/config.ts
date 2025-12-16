import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { KnownProvider } from "@mariozechner/pi-ai";
import type { RiskLevel } from "./types.js";

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

export function loadConfig(): Config {
  const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const configPath = join(configDir, "tau", "config.json");

  try {
    if (!existsSync(configPath)) {
      return {};
    }

    const content = readFileSync(configPath, "utf-8");
    const config = JSON.parse(content) as Config;
    if (typeof config !== "object" || config === null) return {};

    const mode = config.toolDisplayMode;
    if (mode !== undefined && mode !== "compact" && mode !== "full") {
      delete config.toolDisplayMode;
    }

    const defaultPersona = config.defaultPersona;
    if (defaultPersona !== undefined && typeof defaultPersona !== "string") {
      delete config.defaultPersona;
    }

    const defaultRisk = config.defaultRisk;
    if (defaultRisk !== undefined && !["none", "read-only", "read-write"].includes(defaultRisk)) {
      delete config.defaultRisk;
    }

    const apiKeys = config.apiKeys as Record<string, unknown> | undefined;
    if (apiKeys !== undefined) {
      if (typeof apiKeys !== "object" || apiKeys === null) {
        delete config.apiKeys;
      } else {
        for (const key of ["anthropic", "google", "openai", "parallel"] as const) {
          const value = apiKeys[key];
          if (value !== undefined && typeof value !== "string") {
            delete apiKeys[key];
          }
        }
      }
    }

    return config;
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
