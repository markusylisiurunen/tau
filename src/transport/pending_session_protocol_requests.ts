import { randomUUID } from "node:crypto";
import {
  createSessionProtocolRequest,
  type SessionProtocolError,
  type SessionProtocolMethod,
  type SessionProtocolParamsByMethod,
  type SessionProtocolRequestId,
  type SessionProtocolRequestMessage,
  type SessionProtocolResultByMethod,
  validateSessionProtocolResult,
} from "../protocol/session_protocol.js";
import { TauSessionProtocolResponseError, TauTransportError } from "./errors.js";

export type PendingSessionProtocolRequest<M extends SessionProtocolMethod> = {
  readonly request: SessionProtocolRequestMessage;
  readonly promise: Promise<SessionProtocolResultByMethod[M]>;
};

type PendingRequest = {
  readonly requestId: SessionProtocolRequestId;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: unknown) => void;
};

export class PendingSessionProtocolRequests {
  private readonly pendingRequests = new Map<SessionProtocolRequestId, PendingRequest>();

  create<M extends SessionProtocolMethod>(
    method: M,
    params: SessionProtocolParamsByMethod[M],
  ): PendingSessionProtocolRequest<M> {
    const requestId = randomUUID();
    const request = createSessionProtocolRequest(requestId, method, params);
    if (!request.ok) {
      throw new TauSessionProtocolResponseError({
        requestId,
        error: request.error,
      });
    }

    let pending!: PendingRequest;
    const promise = new Promise<SessionProtocolResultByMethod[M]>((resolve, reject) => {
      pending = {
        requestId,
        resolve: (responseResult) => {
          const result = validateSessionProtocolResult(method, responseResult);
          if (!result.ok) {
            reject(
              new TauTransportError(
                `received invalid session protocol response result: ${result.error.message}`,
              ),
            );
            return;
          }

          resolve(result.value);
        },
        reject,
      };
    });

    this.pendingRequests.set(requestId, pending);

    return {
      request: request.value,
      promise,
    };
  }

  resolveSuccess(id: SessionProtocolRequestId, result: unknown): boolean {
    const pending = this.pendingRequests.get(id);
    if (!pending) {
      return false;
    }

    this.pendingRequests.delete(id);
    pending.resolve(result);
    return true;
  }

  rejectProtocolError(id: SessionProtocolRequestId, error: SessionProtocolError): boolean {
    return this.reject(
      id,
      new TauSessionProtocolResponseError({
        requestId: id,
        error,
      }),
    );
  }

  reject(id: SessionProtocolRequestId, error: unknown): boolean {
    const pending = this.pendingRequests.get(id);
    if (!pending) {
      return false;
    }

    this.pendingRequests.delete(id);
    pending.reject(error);
    return true;
  }

  rejectAll(error: unknown): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }
}
