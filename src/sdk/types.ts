import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import type { Message } from "@mariozechner/pi-ai";

export type TauSdkRequestId = string | number;

export type TauSdkRpcMethod =
  | "initialize"
  | "session.submit"
  | "session.interrupt"
  | "session.snapshot"
  | "session.reset"
  | "session.shutdown";

export type TauSdkInitializeParams = {
  client: {
    name: string;
    version: string;
  };
};

export type TauSdkEvent = {
  version: 1;
  type: "event";
  event: {
    version: number;
    event: unknown;
  };
  requestId?: TauSdkRequestId;
};

export type TauSdkReadyMessage = {
  version: 1;
  type: "ready";
  sessionId: string;
  methods: TauSdkRpcMethod[];
  coreEventVersion: number;
};

export type TauSdkSessionSubmitResult = {
  userHistoryEntryId: string;
  turn: {
    aborted: boolean;
  };
};

export type TauSdkSessionInterruptResult = {
  interrupted: boolean;
  isTurnRunning: boolean;
};

export type TauSdkHistoryEntry = {
  id: string;
  message: Message;
};

export type TauSdkSessionSnapshotResult = {
  sessionId: string;
  isTurnRunning: boolean;
  historyLength: number;
  history: Message[];
  historyEntries: TauSdkHistoryEntry[];
};

export type TauSdkSessionResetResult = {
  previousSessionId: string;
  sessionId: string;
};

export type TauSdkSessionShutdownResult = {
  shutdown: true;
};

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
