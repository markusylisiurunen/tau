import type { RuntimeConfigResult } from "../core/config/index.js";
import { loadRuntimeConfigFromToolBackend } from "../core/config/runtime_config_snapshot.js";
import {
  type RuntimePromptBootstrap,
  resolveRuntimePromptBootstrap,
} from "../core/runtime/runtime_bootstrap.js";
import { ToolCatalog } from "../core/tools/catalog.js";
import {
  scopeToolExecutionBackend,
  type ToolExecutionBackend,
} from "../core/tools/execution_backend.js";
import type { ToolRegistry } from "../core/tools/registry.js";
import type { SessionProtocolExecutionEnvironmentSnapshot } from "../protocol/session_protocol.js";
import type {
  ExecutionEnvironment,
  ExecutionRuntimeContext,
  ResolveExecutionRuntimeContextOptions,
} from "./execution_environment.js";

type BackendExecutionSnapshot = SessionProtocolExecutionEnvironmentSnapshot & {
  cwd: string;
  home: string;
};

export class ToolBackendExecutionEnvironment<TSnapshot extends BackendExecutionSnapshot>
  implements ExecutionEnvironment
{
  readonly cwd: string;
  readonly home: string;
  private readonly environmentSnapshot: TSnapshot;
  private readonly backend: ToolExecutionBackend;
  private readonly scopedBackend: ToolExecutionBackend;
  private readonly toolRegistry: ToolRegistry;

  constructor(options: {
    snapshot: TSnapshot;
    backend: ToolExecutionBackend;
    env?: Record<string, string>;
  }) {
    this.environmentSnapshot = options.snapshot;
    this.cwd = options.snapshot.cwd;
    this.home = options.snapshot.home;
    this.backend = options.backend;
    this.scopedBackend = scopeToolExecutionBackend(options.backend, this.cwd, options.env);
    this.toolRegistry = ToolCatalog.createRegistry(this.scopedBackend);
  }

  async resolveRuntimeConfig(cwd: string): Promise<RuntimeConfigResult> {
    return await loadRuntimeConfigFromToolBackend({
      backend: this.backend,
      cwd,
      home: this.home,
    });
  }

  async resolveRuntimeContext(
    options: ResolveExecutionRuntimeContextOptions,
  ): Promise<ExecutionRuntimeContext> {
    const promptBootstrap: RuntimePromptBootstrap = await resolveRuntimePromptBootstrap({
      persona: options.persona,
      discoveredSkills: options.discoveredSkills,
      cwd: options.cwd,
      home: this.home,
      includeAgentContext: options.includeAgentContext,
      agentContextFiles: options.agentContextFiles,
      backend: this.backend,
    });

    return {
      promptBootstrap,
      toolRegistry: this.toolRegistry,
    };
  }

  snapshot(): TSnapshot {
    return structuredClone(this.environmentSnapshot);
  }

  getToolExecutionBackend(): ToolExecutionBackend {
    return this.scopedBackend;
  }

  async dispose(): Promise<void> {
    await this.backend.dispose();
  }
}
