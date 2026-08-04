import { type Config, getHistoryApiKey } from "../config/index.js";
import type { HistoryRemoteTarget } from "./types.js";

export function resolveHistoryRemoteTarget(
  config: Config,
  env?: NodeJS.ProcessEnv,
): HistoryRemoteTarget | undefined {
  if (!config.history) return undefined;
  const apiKey = getHistoryApiKey(config.history, env);
  if (!apiKey) {
    throw new Error(
      "history is configured but no API key is available; set TAU_HISTORY_API_KEY, history.apiKey, or history.apiKeyEnv",
    );
  }
  return { endpoint: config.history.endpoint, apiKey };
}
