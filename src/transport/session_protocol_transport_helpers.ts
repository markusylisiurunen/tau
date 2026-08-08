import type {
  SessionProtocolClientToolMessage,
  SessionProtocolDeltaMessage,
  SessionProtocolEphemeralMessage,
  SessionProtocolOutgoingParseFailure,
  SessionProtocolParsedResponseMessage,
  SessionProtocolPendingUserMessagesMessage,
  SessionProtocolSubagentActivitiesMessage,
} from "../protocol/session_protocol.js";
import { TauTransportError } from "./errors.js";
import type { PendingSessionProtocolRequests } from "./pending_session_protocol_requests.js";
import type {
  SessionProtocolClientToolListener,
  SessionProtocolDeltaListener,
  SessionProtocolEphemeralListener,
  SessionProtocolFailureListener,
  SessionProtocolPendingUserMessagesListener,
  SessionProtocolSubagentActivitiesListener,
} from "./session_transport.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutError: Error,
): Promise<T> {
  let timeout: NodeJS.Timeout;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => reject(timeoutError), timeoutMs);
    timeout.unref?.();
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeout);
  });
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    timeout.unref?.();
  });
}

export async function waitForPromiseOrTimeout(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  await Promise.race([promise, delay(timeoutMs)]);
}

export function notifySessionProtocolDeltaListeners(
  listeners: ReadonlySet<SessionProtocolDeltaListener>,
  message: SessionProtocolDeltaMessage,
  options: { ignoreListenerErrors?: boolean } = {},
): void {
  for (const listener of [...listeners]) {
    if (!options.ignoreListenerErrors) {
      listener(message);
      continue;
    }

    try {
      listener(message);
    } catch {
      // listener failures must not break transport processing
    }
  }
}

export function notifySessionProtocolClientToolListeners(
  listeners: Set<SessionProtocolClientToolListener>,
  message: SessionProtocolClientToolMessage,
  options: { ignoreListenerErrors?: boolean } = {},
): void {
  for (const listener of listeners) {
    try {
      listener(message);
    } catch (error) {
      if (!options.ignoreListenerErrors) {
        throw error;
      }
    }
  }
}

export function notifySessionProtocolFailureListeners(
  listeners: ReadonlySet<SessionProtocolFailureListener>,
  error: Error,
): void {
  for (const listener of [...listeners]) {
    try {
      listener(error);
    } catch {
      // listener failures must not break transport processing
    }
  }
}

export function notifySessionProtocolEphemeralListeners(
  listeners: ReadonlySet<SessionProtocolEphemeralListener>,
  message: SessionProtocolEphemeralMessage,
  options: { ignoreListenerErrors?: boolean } = {},
): void {
  for (const listener of [...listeners]) {
    if (!options.ignoreListenerErrors) {
      listener(message);
      continue;
    }

    try {
      listener(message);
    } catch {
      // listener failures must not break transport processing
    }
  }
}

export function notifySessionProtocolPendingUserMessagesListeners(
  listeners: ReadonlySet<SessionProtocolPendingUserMessagesListener>,
  message: SessionProtocolPendingUserMessagesMessage,
  options: { ignoreListenerErrors?: boolean } = {},
): void {
  for (const listener of [...listeners]) {
    if (!options.ignoreListenerErrors) {
      listener(message);
      continue;
    }

    try {
      listener(message);
    } catch {
      // listener failures must not break transport processing
    }
  }
}

export function notifySessionProtocolSubagentActivitiesListeners(
  listeners: ReadonlySet<SessionProtocolSubagentActivitiesListener>,
  message: SessionProtocolSubagentActivitiesMessage,
  options: { ignoreListenerErrors?: boolean } = {},
): void {
  for (const listener of [...listeners]) {
    if (!options.ignoreListenerErrors) {
      listener(message);
      continue;
    }

    try {
      listener(message);
    } catch {
      // listener failures must not break transport processing
    }
  }
}

export function handleSessionProtocolTransportResponse(
  message: SessionProtocolParsedResponseMessage,
  pendingRequests: PendingSessionProtocolRequests,
  failTransport: (error: Error) => void,
): void {
  if (message.ok) {
    const resolved = pendingRequests.resolveSuccess(message.id, message.result);
    if (!resolved) {
      failTransport(
        new TauTransportError(
          `received response for unknown session protocol request '${message.id}'`,
        ),
      );
    }
    return;
  }

  if (message.id === null) {
    failTransport(new TauTransportError("received uncorrelated session protocol error response"));
    return;
  }

  const rejected = pendingRequests.rejectProtocolError(message.id, message.error);
  if (!rejected) {
    failTransport(
      new TauTransportError(
        `received response for unknown session protocol request '${message.id}'`,
      ),
    );
  }
}

export function handleSessionProtocolTransportParseFailure(options: {
  failure: SessionProtocolOutgoingParseFailure;
  pendingRequests: PendingSessionProtocolRequests;
  failTransport: (error: Error) => void;
  malformedJsonPeer: string;
  invalidPayloadPeer: string;
}): void {
  const { failure, pendingRequests, failTransport, malformedJsonPeer, invalidPayloadPeer } =
    options;

  if (failure.messageType === "response" && failure.id !== null) {
    const rejected = pendingRequests.reject(
      failure.id,
      new TauTransportError("received malformed session protocol response"),
    );
    if (!rejected) {
      failTransport(
        new TauTransportError(
          `received malformed response for unknown session protocol request '${failure.id}'`,
        ),
      );
    }
    return;
  }

  if (failure.reason === "parse_error") {
    failTransport(new TauTransportError(`received malformed JSON from ${malformedJsonPeer}`));
    return;
  }

  if (failure.reason === "response_invalid_id") {
    failTransport(new TauTransportError("received response without a valid request id"));
    return;
  }

  if (failure.reason === "unsupported_version" || failure.reason === "unsupported_message_type") {
    failTransport(
      new TauTransportError(`received ${failure.error.message} from ${invalidPayloadPeer}`),
    );
    return;
  }

  failTransport(
    new TauTransportError(
      `received invalid session protocol payload from ${invalidPayloadPeer}: ${failure.error.message}`,
    ),
  );
}
