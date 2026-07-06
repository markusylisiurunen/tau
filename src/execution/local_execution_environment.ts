import {
  createDefaultConfigDeps,
  loadRuntimeConfig,
  type RuntimeConfigResult,
} from "../core/config/index.js";
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
import type {
  SessionProtocolExecutionEnvironmentInput,
  SessionProtocolExecutionEnvironmentSnapshot,
} from "../protocol/session_protocol.js";
import type {
  ExecutionEnvironment,
  ExecutionEnvironmentResolver,
  ExecutionRuntimeContext,
  ResolveExecutionRuntimeContextOptions,
} from "./execution_environment.js";

export type LocalExecutionEnvironmentOptions = {
  cwd: string;
  home: string;
  readFile: (path: string) => string;
  toolBackend: ToolExecutionBackend;
  toolRegistry: ToolRegistry;
};

export class LocalExecutionEnvironment implements ExecutionEnvironment {
  readonly kind: "local" = "local";
  readonly cwd: string;
  readonly home: string;
  private readonly toolRegistry: ToolRegistry;
  private readonly toolBackend: ToolExecutionBackend;
  private readonly readFile: (path: string) => string;

  constructor(options: LocalExecutionEnvironmentOptions) {
    this.cwd = options.cwd;
    this.home = options.home;
    this.readFile = options.readFile;
    this.toolBackend = options.toolBackend;
    this.toolRegistry = options.toolRegistry;
  }

  async resolveRuntimeConfig(): Promise<RuntimeConfigResult> {
    const deps = createDefaultConfigDeps();
    return await loadRuntimeConfig(this.cwd, {
      ...deps,
      env: {
        ...deps.env,
        cwd: () => this.cwd,
        home: () => this.home,
      },
    });
  }

  resolveRuntimeContext(options: ResolveExecutionRuntimeContextOptions): ExecutionRuntimeContext {
    const promptBootstrap: RuntimePromptBootstrap = resolveRuntimePromptBootstrap({
      persona: options.persona,
      discoveredSkills: options.discoveredSkills,
      cwd: this.cwd,
      home: this.home,
      includeAgentContext: options.includeAgentContext,
      readFile: this.readFile,
    });

    return {
      promptBootstrap,
      toolRegistry: this.toolRegistry,
    };
  }

  snapshot() {
    return {
      kind: this.kind,
      cwd: this.cwd,
      home: this.home,
    };
  }

  getToolExecutionBackend(): ToolExecutionBackend {
    return this.toolBackend;
  }

  async dispose(): Promise<void> {}
}

export type LocalExecutionEnvironmentResolverOptions = {
  home: string;
  readFile: (path: string) => string;
  toolBackend: ToolExecutionBackend;
};

export class LocalExecutionEnvironmentResolver implements ExecutionEnvironmentResolver {
  private readonly home: string;
  private readonly readFile: (path: string) => string;
  private readonly toolBackend: ToolExecutionBackend;

  constructor(options: LocalExecutionEnvironmentResolverOptions) {
    this.home = options.home;
    this.readFile = options.readFile;
    this.toolBackend = options.toolBackend;
  }

  async resolve(input: SessionProtocolExecutionEnvironmentInput) {
    if (input.kind !== "local") {
      throw new Error(`unsupported execution environment kind '${input.kind}'`);
    }
    return this.createLocalEnvironment(input.cwd);
  }

  canRestore(snapshot: SessionProtocolExecutionEnvironmentSnapshot): boolean {
    return snapshot.kind === "local";
  }

  async restore(snapshot: SessionProtocolExecutionEnvironmentSnapshot) {
    if (snapshot.kind !== "local") {
      throw new Error(`unsupported execution environment kind '${snapshot.kind}'`);
    }
    return this.createLocalEnvironment(snapshot.cwd, snapshot.home);
  }

  private createLocalEnvironment(cwd: string, home = this.home): LocalExecutionEnvironment {
    const scopedBackend = scopeToolExecutionBackend(this.toolBackend, cwd);
    return new LocalExecutionEnvironment({
      cwd,
      home,
      readFile: this.readFile,
      toolBackend: scopedBackend,
      toolRegistry: ToolCatalog.createRegistry(scopedBackend),
    });
  }
}
