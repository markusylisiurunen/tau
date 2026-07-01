import type { RuntimeConfigResult } from "../core/config/index.js";
import type { RuntimePromptBootstrap } from "../core/runtime/runtime_bootstrap.js";
import type { ToolExecutionBackend } from "../core/tools/execution_backend.js";
import type { ToolRegistry } from "../core/tools/registry.js";
import type { Persona, Skill } from "../core/types.js";
import type {
  SessionProtocolExecutionEnvironmentInput,
  SessionProtocolExecutionEnvironmentSnapshot,
} from "../protocol/session_protocol.js";

export type ResolveExecutionRuntimeContextOptions = {
  persona: Persona;
  discoveredSkills: Skill[];
  includeAgentContext: boolean;
};

export type ExecutionRuntimeContext = {
  promptBootstrap: RuntimePromptBootstrap;
  toolRegistry: ToolRegistry;
};

export type MaybePromise<T> = T | Promise<T>;

export interface ExecutionEnvironment {
  resolveRuntimeConfig(): MaybePromise<RuntimeConfigResult>;
  resolveRuntimeContext(
    options: ResolveExecutionRuntimeContextOptions,
  ): MaybePromise<ExecutionRuntimeContext>;
  getToolExecutionBackend(): ToolExecutionBackend;
  snapshot(): SessionProtocolExecutionEnvironmentSnapshot;
  dispose(): Promise<void>;
}

export interface ExecutionEnvironmentResolver {
  resolve(input: SessionProtocolExecutionEnvironmentInput): Promise<ExecutionEnvironment>;
  canRestore(snapshot: SessionProtocolExecutionEnvironmentSnapshot): boolean;
  restore(snapshot: SessionProtocolExecutionEnvironmentSnapshot): Promise<ExecutionEnvironment>;
}

export type ExecutionEnvironmentResolverMap = {
  [K in SessionProtocolExecutionEnvironmentInput["kind"]]: ExecutionEnvironmentResolver;
};

export class CompositeExecutionEnvironmentResolver implements ExecutionEnvironmentResolver {
  private readonly resolvers: Partial<ExecutionEnvironmentResolverMap>;

  constructor(resolvers: Partial<ExecutionEnvironmentResolverMap>) {
    this.resolvers = resolvers;
  }

  resolve(input: SessionProtocolExecutionEnvironmentInput): Promise<ExecutionEnvironment> {
    return this.getResolver(input.kind).resolve(input);
  }

  canRestore(snapshot: SessionProtocolExecutionEnvironmentSnapshot): boolean {
    const resolver = this.resolvers[snapshot.kind];
    return resolver ? resolver.canRestore(snapshot) : false;
  }

  restore(snapshot: SessionProtocolExecutionEnvironmentSnapshot): Promise<ExecutionEnvironment> {
    return this.getResolver(snapshot.kind).restore(snapshot);
  }

  private getResolver(kind: SessionProtocolExecutionEnvironmentInput["kind"]) {
    const resolver = this.resolvers[kind];
    if (!resolver) {
      throw new Error(`unsupported execution environment kind '${kind}'`);
    }
    return resolver;
  }
}
