import type { TauSdkRequestId } from "./types.js";

export type TauRpcErrorCode =
  | "parse_error"
  | "invalid_request"
  | "method_not_found"
  | "invalid_params"
  | "busy"
  | "internal_error";

export type TauRpcError = {
  code: TauRpcErrorCode;
  message: string;
  data?: unknown;
};

export class TauSdkError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TauSdkError";
  }
}

export class TauRpcResponseError extends TauSdkError {
  readonly code: TauRpcErrorCode;
  readonly requestId: TauSdkRequestId;
  readonly data?: unknown;

  constructor(options: { requestId: TauSdkRequestId; error: TauRpcError }) {
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
