import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import type {
  RpcEventMessage,
  RpcInitializeParams,
  RpcReadyMessage,
  RpcRequestId,
  RpcSessionInterruptResult,
  RpcSessionResetResult,
  RpcSessionShutdownResult,
  RpcSessionSnapshotResult,
  RpcSessionSubmitResult,
} from "../core/modes/rpc_protocol.js";
import type { RiskLevel } from "../core/types.js";

export type TauSdkSpawnFunction = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export type TauSdkClientOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  persona?: string;
  riskLevel?: RiskLevel;
  sandbox?: boolean;
  noAgentContextFiles?: boolean;
  executable?: string;
  executableArgs?: string[];
  scriptPath?: string | null;
  scriptArgs?: string[];
  rpcArgs?: string[];
  connectTimeoutMs?: number;
  initialize?: RpcInitializeParams;
  spawn?: TauSdkSpawnFunction;
};

export type TauSdkSubmitOptions = {
  historyEntryId?: string;
};

export type TauSdkEvent = RpcEventMessage;
export type TauSdkEventListener = (event: TauSdkEvent) => void;

export type TauSdkClient = {
  readonly ready: RpcReadyMessage;
  submit(text: string, options?: TauSdkSubmitOptions): Promise<RpcSessionSubmitResult>;
  interrupt(): Promise<RpcSessionInterruptResult>;
  snapshot(): Promise<RpcSessionSnapshotResult>;
  reset(): Promise<RpcSessionResetResult>;
  shutdown(): Promise<RpcSessionShutdownResult>;
  close(): Promise<void>;
  onEvent(listener: TauSdkEventListener): () => void;
};

export type PendingRequest = {
  readonly method: string;
  readonly requestId: RpcRequestId;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
};
