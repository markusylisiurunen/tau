import type {
  SessionProtocolError,
  SessionProtocolErrorCode,
  SessionProtocolRequestId,
} from "../protocol/session_protocol.js";

export type TauSessionProtocolErrorCode = SessionProtocolErrorCode;
export type TauSessionProtocolError = SessionProtocolError;

export class TauSessionClientError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TauSessionClientError";
  }
}

export class TauSessionProtocolResponseError extends TauSessionClientError {
  readonly code: TauSessionProtocolErrorCode;
  readonly requestId: SessionProtocolRequestId;
  readonly data?: unknown;

  constructor(options: { requestId: SessionProtocolRequestId; error: TauSessionProtocolError }) {
    super(options.error.message);
    this.name = "TauSessionProtocolResponseError";
    this.code = options.error.code;
    this.requestId = options.requestId;
    this.data = options.error.data;
  }
}

export class TauTransportError extends TauSessionClientError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TauTransportError";
  }
}
