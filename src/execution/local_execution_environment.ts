import type { ToolExecutionBackend } from "../core/tools/execution_backend.js";
import type {
  SessionProtocolExecutionEnvironmentInput,
  SessionProtocolExecutionEnvironmentSnapshot,
  SessionProtocolLocalExecutionEnvironmentSnapshot,
} from "../protocol/session_protocol.js";
import type { ExecutionEnvironmentResolver } from "./execution_environment.js";
import { ToolBackendExecutionEnvironment } from "./tool_backend_execution_environment.js";

export class LocalExecutionEnvironment extends ToolBackendExecutionEnvironment<SessionProtocolLocalExecutionEnvironmentSnapshot> {
  readonly kind = "local" as const;

  constructor(options: {
    cwd: string;
    home: string;
    env?: Record<string, string>;
    backend: ToolExecutionBackend;
  }) {
    super({
      snapshot: {
        kind: "local",
        cwd: options.cwd,
        home: options.home,
        ...(options.env && Object.keys(options.env).length > 0 ? { env: options.env } : {}),
      },
      backend: options.backend,
      env: options.env,
    });
  }
}

export type LocalExecutionEnvironmentResolverOptions = {
  home: string;
  toolBackend: ToolExecutionBackend;
};

export class LocalExecutionEnvironmentResolver implements ExecutionEnvironmentResolver {
  private readonly home: string;
  private readonly toolBackend: ToolExecutionBackend;

  constructor(options: LocalExecutionEnvironmentResolverOptions) {
    this.home = options.home;
    this.toolBackend = options.toolBackend;
  }

  async resolve(input: SessionProtocolExecutionEnvironmentInput) {
    if (input.kind !== "local") {
      throw new Error(`unsupported execution environment kind '${input.kind}'`);
    }
    return this.createLocalEnvironment(input.cwd, this.home, input.env ?? {});
  }

  canRestore(snapshot: SessionProtocolExecutionEnvironmentSnapshot): boolean {
    return snapshot.kind === "local";
  }

  async restore(snapshot: SessionProtocolExecutionEnvironmentSnapshot) {
    if (snapshot.kind !== "local") {
      throw new Error(`unsupported execution environment kind '${snapshot.kind}'`);
    }
    return this.createLocalEnvironment(snapshot.cwd, snapshot.home, snapshot.env ?? {});
  }

  private createLocalEnvironment(
    cwd: string,
    home: string,
    env: Record<string, string>,
  ): LocalExecutionEnvironment {
    return new LocalExecutionEnvironment({
      cwd,
      home,
      env,
      backend: this.toolBackend,
    });
  }
}
