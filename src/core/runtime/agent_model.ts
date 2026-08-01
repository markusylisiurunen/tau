import { cleanupSessionResources } from "@earendil-works/pi-ai";
import type { AgentSpec } from "../agent/agent_runtime.js";
import { getAuthPath } from "../auth/auth_paths.js";
import { AuthStorage } from "../auth/auth_storage.js";
import { type Config, normalizeAutoCompactConfig } from "../config/index.js";
import type { Persona } from "../types.js";
import { CODEX_ORIGINATOR, CODEX_USER_AGENT } from "../utils/codex.js";
import { resolveModelNotice } from "../utils/model_notices.js";
import { ModelRuntime } from "../utils/model_stream.js";
import { parseStreamingSettings } from "../utils/streaming_settings.js";
import { type CoreDeps, createDefaultCoreDeps } from "./deps.js";
import type { ModelExecutor } from "./model_executor.js";

export type ResolvedAgentModel = Pick<
  AgentSpec,
  "model" | "modelNotice" | "attribution" | "streamOptions" | "compactionPolicy"
>;

export function resolveAgentModel(
  persona: Persona,
  config: Config,
  options: { includeModelNotice: boolean; deps?: CoreDeps },
): ResolvedAgentModel {
  const resolvedDeps = options.deps ?? createDefaultCoreDeps();
  const resolvedConfig = structuredClone(config);
  const authPath = getAuthPath(resolvedDeps.env.home());
  const runtime = new ModelRuntime({
    authStorage: new AuthStorage(authPath),
    getConfig: () => resolvedConfig,
    authPath,
    env: resolvedDeps.env.env(),
  });
  const streamOptions = parseStreamingSettings({ ...persona.settings });
  if (persona.model.provider === "openai-codex") {
    streamOptions.headers = {
      ...streamOptions.headers,
      originator: CODEX_ORIGINATOR,
      "User-Agent": CODEX_USER_AGENT,
    };
  }
  const model: ModelExecutor = {
    model: persona.model,
    stream: (context, options) => runtime.streamModel(persona.model, context, options),
    noteProviderError: async (options) => {
      await runtime.noteProviderError(persona.model.provider, options);
    },
    cleanupSession: cleanupSessionResources,
  };
  const modelNotice = options.includeModelNotice
    ? resolveModelNotice(resolvedConfig, persona.model)
    : undefined;
  return {
    model,
    ...(modelNotice ? { modelNotice } : {}),
    attribution: {
      personaId: persona.id,
      reasoningEffort: persona.settings.reasoning ?? "none",
    },
    streamOptions,
    compactionPolicy: normalizeAutoCompactConfig(resolvedConfig.autoCompact),
  };
}
