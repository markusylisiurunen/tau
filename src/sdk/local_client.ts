import { homedir } from "node:os";
import { parsePersonaString } from "../core/cli.js";
import type { Config } from "../core/config/schema.js";
import { resolveHistoryRemoteTarget } from "../core/history/config.js";
import { HistoryManager } from "../core/history/history_manager.js";
import { getDefaultHistoryDatabasePath } from "../core/history/local_history_store.js";
import {
  getDefaultModelCatalogStorePath,
  RemoteModelCatalog,
} from "../core/models/remote_catalog.js";
import { createDefaultCoreDeps } from "../core/runtime/deps.js";
import { createLocalToolExecutionBackend } from "../core/tools/execution_backend.js";
import type { Persona } from "../core/types.js";
import { CompositeExecutionEnvironmentResolver } from "../execution/execution_environment.js";
import { LocalExecutionEnvironmentResolver } from "../execution/local_execution_environment.js";
import { LocalSessionHost } from "../host/local_session_host.js";
import { FileSessionStore, getDefaultSessionStoreDirectory } from "../store/file_session_store.js";
import { InProcessSessionProtocolTransport } from "../transport/in_process_session_transport.js";
import { TauTransportError } from "../transport/index.js";
import { createTauSdkClientFromTransport, resolveTauSdkInitializeParams } from "./session.js";
import type { TauSdkClient, TauSdkClientOptions } from "./types.js";

export async function createTauSdkClientWithHostConfig(
  options: TauSdkClientOptions,
  config: Config,
  runtimeOptions: { remoteModelCatalog?: RemoteModelCatalog } = {},
): Promise<TauSdkClient> {
  resolveTauSdkInitializeParams(options.initialize, options.clientTools);
  const host = await createInProcessSdkHost(options, config, runtimeOptions);
  const transport = new InProcessSessionProtocolTransport({ host, closeMode: "shutdown-host" });
  return createTauSdkClientFromTransport(transport, options);
}

async function createInProcessSdkHost(
  options: TauSdkClientOptions,
  config: Config,
  runtimeOptions: { remoteModelCatalog?: RemoteModelCatalog },
): Promise<LocalSessionHost> {
  const deps = createDefaultCoreDeps();
  const home = deps.env.home() || process.env.HOME || homedir();
  const remoteModelCatalog =
    runtimeOptions.remoteModelCatalog ??
    new RemoteModelCatalog({ path: getDefaultModelCatalogStorePath(home) });
  if (process.env.TAU_OFFLINE === undefined) {
    void remoteModelCatalog.refresh().catch(() => {});
  }

  const toolBackend = createLocalToolExecutionBackend();
  const localResolver = new LocalExecutionEnvironmentResolver({
    home,
    toolBackend,
  });
  const resolvers: ConstructorParameters<typeof CompositeExecutionEnvironmentResolver>[0] = {
    local: localResolver,
  };
  if (config.cloudflareSandbox?.bridges) {
    const { CloudflareSandboxExecutionEnvironmentResolver } = await import(
      "../execution/cloudflare_sandbox_execution_environment.js"
    );
    resolvers["cloudflare-sandbox"] = new CloudflareSandboxExecutionEnvironmentResolver({
      bridges: config.cloudflareSandbox.bridges,
    });
  }
  if (config.flySprites?.apis) {
    const { FlySpriteExecutionEnvironmentResolver } = await import(
      "../execution/fly_sprite_execution_environment.js"
    );
    resolvers["fly-sprite"] = new FlySpriteExecutionEnvironmentResolver({
      apis: config.flySprites.apis,
    });
  }
  const executionEnvironmentResolver = new CompositeExecutionEnvironmentResolver(resolvers);

  return new LocalSessionHost({
    store: new FileSessionStore({ directory: getDefaultSessionStoreDirectory(home) }),
    history: HistoryManager.open(getDefaultHistoryDatabasePath(home)),
    historyRemote: resolveHistoryRemoteTarget(config),
    executionEnvironmentResolver,
    includeAgentContext: !options.noAgentContextFiles,
    getRemoteModelCatalog: () => remoteModelCatalog.snapshot(),
    environment: {
      now: () => deps.clock.now(),
    },
    deps,
    resolveSessionBootstrap: async ({ executionEnvironment, remoteCatalog }) => {
      const snapshot = executionEnvironment.snapshot();
      const envRuntime = await executionEnvironment.resolveRuntimeConfig(snapshot.cwd, {
        remoteCatalog,
      });
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
        modelResolver: envRuntime.bootstrap.modelResolver.resolveModel,
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
