import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import type {
  RpcEventMessage,
  RpcInitializeParams,
  RpcMethod,
  RpcReadyMessage,
  RpcRequestId,
  RpcResultByMethod,
} from "../core/modes/rpc_protocol.js";

export type TauSdkRequestId = RpcRequestId;

export type TauSdkRpcMethod = RpcMethod;

export type TauSdkInitializeParams = RpcInitializeParams;

export type TauSdkEvent = RpcEventMessage;

export type TauSdkReadyMessage = RpcReadyMessage;

export type TauSdkSessionSubmitResult = RpcResultByMethod["session.submit"];

export type TauSdkSessionInterruptResult = RpcResultByMethod["session.interrupt"];

export type TauSdkSessionSnapshotResult = RpcResultByMethod["session.snapshot"];

export type TauSdkSessionResetResult = RpcResultByMethod["session.reset"];

export type TauSdkSessionShutdownResult = RpcResultByMethod["session.shutdown"];

export type TauSdkSpawnFunction = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export type TauSdkClientOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  persona?: string;
  riskLevel?: "read-only" | "read-write";
  sandbox?: boolean;
  noAgentContextFiles?: boolean;
  executable?: string;
  executableArgs?: string[];
  scriptPath?: string | null;
  scriptArgs?: string[];
  rpcArgs?: string[];
  connectTimeoutMs?: number;
  initialize?: TauSdkInitializeParams;
  spawn?: TauSdkSpawnFunction;
};

export type TauSdkSubmitOptions = {
  historyEntryId?: string;
};

export type TauSdkEventListener = (event: TauSdkEvent) => void;

export type TauSdkClient = {
  readonly ready: TauSdkReadyMessage;
  submit(text: string, options?: TauSdkSubmitOptions): Promise<TauSdkSessionSubmitResult>;
  interrupt(): Promise<TauSdkSessionInterruptResult>;
  snapshot(): Promise<TauSdkSessionSnapshotResult>;
  reset(): Promise<TauSdkSessionResetResult>;
  shutdown(): Promise<TauSdkSessionShutdownResult>;
  close(): Promise<void>;
  onEvent(listener: TauSdkEventListener): () => void;
};
