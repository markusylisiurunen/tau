import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { KnownProvider } from "@mariozechner/pi-ai";

export interface Config {
  apiKeys?: {
    anthropic?: string;
    google?: string;
    openai?: string;
  };
  userPreferences?: string;
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
    return typeof config === "object" && config !== null ? config : {};
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
