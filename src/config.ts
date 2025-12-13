import type { KnownProvider } from "@mariozechner/pi-ai";
import fs from "fs";
import os from "os";
import path from "path";

export interface Config {
  apiKeys?: {
    anthropic?: string;
    google?: string;
    openai?: string;
  };
}

export function loadConfig(): Config {
  const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const configPath = path.join(configDir, "tau", "config.json");

  try {
    if (!fs.existsSync(configPath)) {
      return {};
    }

    const content = fs.readFileSync(configPath, "utf-8");
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
