import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { parsePersonaString } from "../core/cli.js";
import { createDefaultConfigDeps, loadRuntimeConfig } from "../core/config/index.js";
import { createDefaultCoreDeps } from "../core/runtime/deps.js";
import { createLocalToolExecutionBackend } from "../core/tools/execution_backend.js";
import type { Persona } from "../core/types.js";
import { CloudflareSandboxExecutionEnvironmentResolver } from "../execution/cloudflare_sandbox_execution_environment.js";
import { CompositeExecutionEnvironmentResolver } from "../execution/execution_environment.js";
import { FlySpriteExecutionEnvironmentResolver } from "../execution/fly_sprite_execution_environment.js";
import { LocalExecutionEnvironmentResolver } from "../execution/local_execution_environment.js";
import { LocalSessionHost } from "../host/local_session_host.js";
import { FileSessionStore, getDefaultSessionStoreDirectory } from "../store/file_session_store.js";
import { InProcessSessionProtocolTransport } from "../transport/in_process_session_transport.js";
import { TauTransportError, WebSocketSessionProtocolTransport } from "../transport/index.js";
import { createTauSdkClientFromTransport, resolveTauSdkInitializeParams } from "./session.js";
import type { TauSdkClient, TauSdkClientOptions, TauSdkWebSocketClientOptions } from "./types.js";

export async function createTauSdkClient(options: TauSdkClientOptions = {}): Promise<TauSdkClient> {
  resolveTauSdkInitializeParams(options.initialize, options.clientTools);
  const host = await createInProcessSdkHost(options);
  const transport = new InProcessSessionProtocolTransport({ host, closeMode: "shutdown-host" });
  return createTauSdkClientFromTransport(transport, options);
}

export async function createTauSdkWebSocketClient(
  options: TauSdkWebSocketClientOptions,
): Promise<TauSdkClient> {
  resolveTauSdkInitializeParams(options.initialize, options.clientTools);
  const transport = new WebSocketSessionProtocolTransport(options);
  return createTauSdkClientFromTransport(transport, options);
}

async function createInProcessSdkHost(options: TauSdkClientOptions): Promise<LocalSessionHost> {
  const deps = createDefaultCoreDeps();
  const configDeps = createDefaultConfigDeps();
  const cwd = options.cwd ?? deps.env.cwd();
  const home = deps.env.home() || process.env.HOME || homedir();
  const runtime = await loadRuntimeConfig(cwd, configDeps);
  if (runtime.personas.length === 0) {
    throw new TauTransportError("no personas available for in-process tau sdk client");
  }

  const selectedPersona = selectSdkPersona(runtime.personas, {
    requestedPersona: options.persona,
    defaultPersona: runtime.config.defaultPersona,
  });
  const persona = clonePersonaForSession(selectedPersona.persona);
  const selectedReasoning = options.reasoning ?? selectedPersona.reasoning;
  if (selectedReasoning !== undefined) {
    persona.settings.reasoning = selectedReasoning;
  }

  const toolBackend = createLocalToolExecutionBackend();
  const localResolver = new LocalExecutionEnvironmentResolver({
    home,
    readFile: (path) => readFileSync(path, "utf-8"),
    toolBackend,
  });
  const executionEnvironmentResolver = new CompositeExecutionEnvironmentResolver({
    local: localResolver,
    ...(runtime.config.cloudflareSandbox?.bridges
      ? {
          "cloudflare-sandbox": new CloudflareSandboxExecutionEnvironmentResolver({
            bridges: runtime.config.cloudflareSandbox.bridges,
          }),
        }
      : {}),
    ...(runtime.config.flySprites?.apis
      ? {
          "fly-sprite": new FlySpriteExecutionEnvironmentResolver({
            apis: runtime.config.flySprites.apis,
          }),
        }
      : {}),
  });

  return new LocalSessionHost({
    store: new FileSessionStore({ directory: getDefaultSessionStoreDirectory(home) }),
    persona,
    discoveredSkills: runtime.skills,
    personas: runtime.personas.map(clonePersonaForSession),
    prompts: runtime.prompts,
    config: runtime.config,
    executionEnvironmentResolver,
    includeAgentContext: !options.noAgentContextFiles,
    environment: {
      now: () => deps.clock.now(),
      platform: () => deps.env.platform(),
      nodeVersion: () => deps.env.nodeVersion(),
    },
    deps,
    resolveSessionBootstrap: async ({ executionEnvironment }) => {
      const snapshot = executionEnvironment.snapshot();
      const envRuntime = await executionEnvironment.resolveRuntimeConfig();
      if (envRuntime.personas.length === 0) {
        throw new Error(
          `no personas available for execution environment cwd '${snapshot.cwd}'. add a custom persona or enable built-ins.`,
        );
      }

      const envSelected = selectSdkPersona(envRuntime.personas, {
        requestedPersona: options.persona,
        defaultPersona: envRuntime.config.defaultPersona,
      });
      const envPersona = clonePersonaForSession(envSelected.persona);
      const envReasoning = options.reasoning ?? envSelected.reasoning;
      if (envReasoning !== undefined) {
        envPersona.settings.reasoning = envReasoning;
      }

      return {
        persona: envPersona,
        discoveredSkills: envRuntime.skills,
        personas: envRuntime.personas.map(clonePersonaForSession),
        prompts: envRuntime.prompts,
        config: envRuntime.config,
      };
    },
  });
}

function selectSdkPersona(
  personas: Persona[],
  options: { requestedPersona?: string; defaultPersona?: string },
): { persona: Persona; reasoning?: ReturnType<typeof parsePersonaString>["reasoning"] } {
  let personaId = options.requestedPersona;
  let reasoning = undefined as ReturnType<typeof parsePersonaString>["reasoning"] | undefined;
  if (personaId) {
    const parsed = parsePersonaString(personaId, personas);
    personaId = parsed.personaId;
    reasoning = parsed.reasoning;
  }
  if (!personaId && options.defaultPersona) {
    const parsed = parsePersonaString(options.defaultPersona, personas);
    personaId = parsed.personaId;
    reasoning = parsed.reasoning;
  }

  const persona = personaId
    ? personas.find((candidate) => candidate.id === personaId)
    : personas[0];
  if (!persona) {
    throw new TauTransportError(`persona '${personaId}' is not available`);
  }
  return { persona, reasoning };
}

function clonePersonaForSession(persona: Persona): Persona {
  return {
    ...persona,
    settings: { ...persona.settings },
    allowedReasoningLevels: persona.allowedReasoningLevels
      ? [...persona.allowedReasoningLevels]
      : undefined,
  };
}
