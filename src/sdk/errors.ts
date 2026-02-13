import type { RpcError, RpcErrorCode, RpcRequestId } from "../core/modes/rpc_protocol.js";

export class TauSdkError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TauSdkError";
  }
}

export class TauRpcResponseError extends TauSdkError {
  readonly code: RpcErrorCode;
  readonly requestId: RpcRequestId;
  readonly data?: unknown;

  constructor(options: { requestId: RpcRequestId; error: RpcError }) {
    super(options.error.message);
    this.name = "TauRpcResponseError";
    this.code = options.error.code;
    this.requestId = options.requestId;
    this.data = options.error.data;
  }
}

export class TauTransportError extends TauSdkError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TauTransportError";
  }
}

export class TauProcessError extends TauTransportError {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;

  constructor(
    message: string,
    options?: {
      exitCode?: number | null;
      signal?: NodeJS.Signals | null;
      stderr?: string;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TauProcessError";
    this.exitCode = options?.exitCode ?? null;
    this.signal = options?.signal ?? null;
    this.stderr = options?.stderr ?? "";
  }
}
