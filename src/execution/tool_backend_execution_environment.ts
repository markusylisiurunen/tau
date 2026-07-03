import type { RuntimeConfigResult } from "../core/config/index.js";
import { loadRuntimeConfigFromToolBackend } from "../core/config/runtime_config_snapshot.js";
import {
  type RuntimePromptBootstrap,
  resolveRuntimePromptBootstrapAsync,
} from "../core/runtime/runtime_bootstrap.js";
import { ToolCatalog, type ToolCatalogOptions } from "../core/tools/catalog.js";
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
    toolCatalogOptions?: ToolCatalogOptions;
  }) {
    this.environmentSnapshot = options.snapshot;
    this.cwd = options.snapshot.cwd;
    this.home = options.snapshot.home;
    this.backend = options.backend;
    this.scopedBackend = scopeToolExecutionBackend(options.backend, this.cwd);
    this.toolRegistry = ToolCatalog.createRegistry(this.scopedBackend, options.toolCatalogOptions);
  }

  async resolveRuntimeConfig(): Promise<RuntimeConfigResult> {
    return await loadRuntimeConfigFromToolBackend({
      backend: this.backend,
      cwd: this.cwd,
      home: this.home,
    });
  }

  async resolveRuntimeContext(
    options: ResolveExecutionRuntimeContextOptions,
  ): Promise<ExecutionRuntimeContext> {
    const promptBootstrap: RuntimePromptBootstrap = await resolveRuntimePromptBootstrapAsync({
      persona: options.persona,
      discoveredSkills: options.discoveredSkills,
      cwd: this.cwd,
      home: this.home,
      includeAgentContext: options.includeAgentContext,
      fs: {
        readFile: async (path) => (await this.backend.readFile(path)).content,
        runBash: (command, runOptions) =>
          this.backend.runBash(command, { cwd: this.cwd, timeoutMs: runOptions?.timeoutMs }),
        listDir: async (path) => (await this.backend.listDir(path)).entries,
      },
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
