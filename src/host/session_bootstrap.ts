import { parsePersonaString } from "../core/cli.js";
import type { SessionConfig } from "../core/config/ownership.js";
import type { SessionRuntimeConfigResult } from "../core/config/runtime.js";
import type { ApiKeysConfig } from "../core/config/schema.js";
import type { ModelResolver } from "../core/models/catalog.js";
import type { RemoteModelCatalogSnapshot } from "../core/models/remote_catalog.js";
import { resolvePersonaSelection } from "../core/persona_selection.js";
import type { PromptTemplate } from "../core/prompts.js";
import type { Persona, ReasoningEffort, Skill } from "../core/types.js";
import type { ExecutionEnvironment } from "../execution/execution_environment.js";
import type { SessionProtocolPersonaOverrides } from "../protocol/session_protocol.js";

export type SessionBootstrap = {
  persona: Persona;
  initialAutoCompactThresholdTokens?: number;
  discoveredSkills: Skill[];
  personas: Persona[];
  prompts: PromptTemplate[];
  modelResolver: ModelResolver;
  config: SessionConfig;
};

/** Explicit choices from the entry point. Without one, the session's own default persona applies. */
export type SessionPersonaRequest =
  | { selection: { personaId: string | null } & SessionProtocolPersonaOverrides }
  | { persona?: string; reasoning?: ReasoningEffort };

export type SessionConfigWarningsDiagnostic = {
  event: "session_config_warnings";
  cwd: string;
  warnings: string[];
};

export async function resolveSessionBootstrap(options: {
  executionEnvironment: Pick<ExecutionEnvironment, "resolveRuntimeConfig" | "snapshot">;
  remoteCatalog: RemoteModelCatalogSnapshot;
  recovering: boolean;
  hostApiKeys: ApiKeysConfig["apiKeys"];
  personaRequest?: SessionPersonaRequest;
  onDiagnostic?: (diagnostic: SessionConfigWarningsDiagnostic) => void;
}): Promise<SessionBootstrap> {
  const { cwd } = options.executionEnvironment.snapshot();
  const runtime = await options.executionEnvironment.resolveRuntimeConfig(cwd, {
    remoteCatalog: options.remoteCatalog,
  });
  if (runtime.warnings.length > 0) {
    try {
      options.onDiagnostic?.({
        event: "session_config_warnings",
        cwd,
        warnings: runtime.warnings,
      });
    } catch {
      // A failing diagnostics listener must not block the session.
    }
  }
  if (runtime.personas.length === 0) {
    throw new Error(
      `no personas available for execution environment cwd '${cwd}'. add a custom persona or enable built-ins.`,
    );
  }

  // A recovered session keeps its stored persona; the host applies it after bootstrap.
  const request = options.recovering ? {} : (options.personaRequest ?? {});
  const selection = "selection" in request ? request.selection : undefined;
  return {
    persona:
      "selection" in request
        ? resolvePersonaSelection(
            runtime.personas,
            runtime.config.defaultPersona,
            request.selection.personaId,
            request.selection,
          )
        : selectPersona(runtime, cwd, request),
    ...(selection?.autoCompactThresholdTokens !== undefined
      ? { initialAutoCompactThresholdTokens: selection.autoCompactThresholdTokens }
      : {}),
    discoveredSkills: runtime.skills,
    personas: runtime.personas.map((persona) => structuredClone(persona)),
    prompts: runtime.prompts,
    modelResolver: runtime.bootstrap.modelResolver.resolveModel,
    config: { ...runtime.config, apiKeys: options.hostApiKeys },
  };
}

function selectPersona(
  runtime: SessionRuntimeConfigResult,
  cwd: string,
  request: { persona?: string; reasoning?: ReasoningEffort },
): Persona {
  const reference = request.persona ?? runtime.config.defaultPersona;
  const parsed = reference ? parsePersonaString(reference, runtime.personas) : undefined;
  if (request.persona !== undefined && !parsed?.personaId) {
    throw new Error(
      `persona '${request.persona}' is not available for execution environment cwd '${cwd}'`,
    );
  }
  const selected =
    runtime.personas.find((persona) => persona.id === parsed?.personaId) ?? runtime.personas[0]!;
  const persona = structuredClone(selected);
  const reasoning = request.reasoning ?? parsed?.reasoning;
  if (reasoning !== undefined) persona.settings.reasoning = reasoning;
  return persona;
}
