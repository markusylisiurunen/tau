import {
  parseSessionProtocolOutgoingLine,
  type SessionProtocolInitializeParams,
  type SessionProtocolMethod,
  type SessionProtocolParamsByMethod,
  type SessionProtocolReadyMessage,
  type SessionProtocolResultByMethod,
} from "../protocol/session_protocol.js";
import { TauTransportError } from "./errors.js";
import {
  type PendingSessionProtocolRequest,
  PendingSessionProtocolRequests,
} from "./pending_session_protocol_requests.js";
import {
  createDeferred,
  handleSessionProtocolTransportParseFailure,
  handleSessionProtocolTransportResponse,
  notifySessionProtocolClientToolListeners,
  notifySessionProtocolDeltaListeners,
  notifySessionProtocolEphemeralListeners,
  waitForPromiseOrTimeout,
  withTimeout,
} from "./session_protocol_transport_helpers.js";
import type {
  SessionProtocolClientToolListener,
  SessionProtocolDeltaListener,
  SessionProtocolEphemeralListener,
  SessionProtocolTransport,
} from "./session_transport.js";

type WebSocketEventName = "open" | "message" | "error" | "close";

type WebSocketLike = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: WebSocketEventName, listener: (event: unknown) => void): void;
  removeEventListener(type: WebSocketEventName, listener: (event: unknown) => void): void;
};

export type WebSocketSessionProtocolTransportOptions = {
  url: string;
  authToken?: string;
  webSocketFactory?: (url: string) => WebSocketLike;
};

const WEB_SOCKET_OPEN = 1;
const WEB_SOCKET_CLOSING = 2;
const WEB_SOCKET_CLOSED = 3;
const WEB_SOCKET_CLOSE_TIMEOUT_MS = 2_000;

export class WebSocketSessionProtocolTransport implements SessionProtocolTransport {
  private readonly url: string;
  private readonly authToken?: string;
  private readonly webSocketFactory?: (url: string) => WebSocketLike;
  private readonly deltaListeners = new Set<SessionProtocolDeltaListener>();
  private readonly ephemeralListeners = new Set<SessionProtocolEphemeralListener>();
  private readonly clientToolListeners = new Set<SessionProtocolClientToolListener>();
  private readonly pendingRequests = new PendingSessionProtocolRequests();
  private readonly readyDeferred = createDeferred<SessionProtocolReadyMessage>();
  private readonly openDeferred = createDeferred<void>();
  private readonly closeDeferred = createDeferred<void>();

  private socket?: WebSocketLike;
  private readyValue?: SessionProtocolReadyMessage;
  private connectPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private isConnected = false;
  private isClosed = false;
  private isSocketOpen = false;
  private fatalError?: Error;

  constructor(options: WebSocketSessionProtocolTransportOptions) {
    this.url = options.url;
    this.authToken = options.authToken;
    this.webSocketFactory = options.webSocketFactory;
  }

  get ready(): SessionProtocolReadyMessage {
    if (!this.readyValue) {
      throw new TauTransportError("tau websocket transport is not connected");
    }

    return this.readyValue;
  }

  async connect(
    initializeParams: SessionProtocolInitializeParams,
    timeoutMs: number,
  ): Promise<void> {
    if (this.isClosed) {
      throw new TauTransportError("tau websocket transport is closed");
    }

    if (this.fatalError) {
      throw this.fatalError;
    }

    if (this.isConnected) {
      return;
    }

    this.connectPromise ??= this.establishConnection(initializeParams, timeoutMs);
    await this.connectPromise;
  }

  private async establishConnection(
    initializeParams: SessionProtocolInitializeParams,
    timeoutMs: number,
  ): Promise<void> {
    const socket = this.createSocket();
    this.socket = socket;
    socket.addEventListener("open", this.handleOpen);
    socket.addEventListener("message", this.handleMessage);
    socket.addEventListener("error", this.handleError);
    socket.addEventListener("close", this.handleClose);

    await withTimeout(
      this.openDeferred.promise,
      timeoutMs,
      new TauTransportError(`timed out opening websocket after ${timeoutMs}ms`),
    );
    const ready = await withTimeout(
      this.readyDeferred.promise,
      timeoutMs,
      new TauTransportError(
        `timed out waiting for session protocol ready message after ${timeoutMs}ms`,
      ),
    );

    this.readyValue = ready;
    await this.request("initialize", initializeParams);
    this.isConnected = true;
  }

  private createSocket(): WebSocketLike {
    const url = withAuthToken(this.url, this.authToken);
    if (this.webSocketFactory) {
      return this.webSocketFactory(url);
    }

    const WebSocketConstructor = globalThis.WebSocket;
    if (!WebSocketConstructor) {
      throw new TauTransportError("global WebSocket is not available in this runtime");
    }

    return new WebSocketConstructor(url) as WebSocketLike;
  }

  request<M extends SessionProtocolMethod>(
    method: M,
    params: SessionProtocolParamsByMethod[M],
  ): Promise<SessionProtocolResultByMethod[M]> {
    if (this.isClosed) {
      return Promise.reject(new TauTransportError("tau websocket transport is closed"));
    }

    if (this.fatalError) {
      return Promise.reject(this.fatalError);
    }

    const socket = this.socket;
    if (!socket || socket.readyState !== WEB_SOCKET_OPEN) {
      return Promise.reject(new TauTransportError("tau websocket transport is not open"));
    }

    let pending: PendingSessionProtocolRequest<M>;
    try {
      pending = this.pendingRequests.create(method, params);
    } catch (error) {
      return Promise.reject(error);
    }

    try {
      socket.send(JSON.stringify(pending.request));
    } catch (error) {
      this.pendingRequests.reject(
        pending.request.id,
        new TauTransportError("failed to write request to tau websocket", { cause: error }),
      );
    }

    return pending.promise;
  }

  onDelta(listener: SessionProtocolDeltaListener): () => void {
    this.deltaListeners.add(listener);
    return () => {
      this.deltaListeners.delete(listener);
    };
  }

  onEphemeral(listener: SessionProtocolEphemeralListener): () => void {
    this.ephemeralListeners.add(listener);
    return () => {
      this.ephemeralListeners.delete(listener);
    };
  }

  onClientTool(listener: SessionProtocolClientToolListener): () => void {
    this.clientToolListeners.add(listener);
    return () => {
      this.clientToolListeners.delete(listener);
    };
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }

    this.isClosed = true;

    const closeError = new TauTransportError("tau websocket transport was closed");
    this.pendingRequests.rejectAll(closeError);
    this.rejectReadyIfPending(closeError);
    this.deltaListeners.clear();
    this.ephemeralListeners.clear();
    this.clientToolListeners.clear();

    this.closePromise = (async () => {
      const socket = this.socket;
      if (socket) {
        if (socket.readyState !== WEB_SOCKET_CLOSING && socket.readyState !== WEB_SOCKET_CLOSED) {
          socket.close(1000, "client closed");
        }
        if (socket.readyState === WEB_SOCKET_OPEN || socket.readyState === WEB_SOCKET_CLOSING) {
          await waitForCloseOrTimeout(this.closeDeferred.promise, WEB_SOCKET_CLOSE_TIMEOUT_MS);
        }
        this.removeSocketListeners(socket);
      }
    })();

    return this.closePromise;
  }

  private readonly handleOpen = (): void => {
    this.isSocketOpen = true;
    this.openDeferred.resolve();
  };

  private readonly handleMessage = (event: unknown): void => {
    const data = readMessageEventData(event);
    if (typeof data !== "string") {
      this.failTransport(new TauTransportError("received non-text websocket message"));
      return;
    }

    this.handleSessionProtocolPayload(data);
  };

  private readonly handleError = (event: unknown): void => {
    this.failTransport(new TauTransportError("tau websocket transport failure", { cause: event }));
  };

  private readonly handleClose = (): void => {
    this.closeDeferred.resolve();
    if (this.isClosed) {
      return;
    }

    this.isClosed = true;
    this.failTransport(new TauTransportError("tau websocket closed unexpectedly"));
  };

  private handleSessionProtocolPayload(payload: string): void {
    const parsed = parseSessionProtocolOutgoingLine(payload);
    if (!parsed.ok) {
      handleSessionProtocolTransportParseFailure({
        failure: parsed,
        pendingRequests: this.pendingRequests,
        failTransport: (error) => this.failTransport(error),
        malformedJsonPeer: "tau websocket",
        invalidPayloadPeer: "tau websocket",
      });
      return;
    }

    const message = parsed.message;
    if (message.type === "ready") {
      if (!this.readyValue) {
        this.readyValue = message;
        this.readyDeferred.resolve(message);
      }
      return;
    }

    if (message.type === "session.delta") {
      notifySessionProtocolDeltaListeners(this.deltaListeners, message, {
        ignoreListenerErrors: true,
      });
      return;
    }

    if (message.type === "session.ephemeral") {
      notifySessionProtocolEphemeralListeners(this.ephemeralListeners, message, {
        ignoreListenerErrors: true,
      });
      return;
    }

    if (
      message.type === "session.clientTool.call" ||
      message.type === "session.clientTool.cancel"
    ) {
      notifySessionProtocolClientToolListeners(this.clientToolListeners, message, {
        ignoreListenerErrors: true,
      });
      return;
    }

    handleSessionProtocolTransportResponse(message, this.pendingRequests, (error) =>
      this.failTransport(error),
    );
  }

  private failTransport(error: Error): void {
    if (this.fatalError) {
      return;
    }

    this.fatalError = error;
    this.pendingRequests.rejectAll(error);
    this.rejectReadyIfPending(error);
  }

  private rejectReadyIfPending(error: Error): void {
    if (this.readyValue || !this.connectPromise) {
      return;
    }

    if (this.isSocketOpen) {
      this.readyDeferred.reject(error);
    }
    this.openDeferred.reject(error);
  }

  private removeSocketListeners(socket: WebSocketLike): void {
    socket.removeEventListener("open", this.handleOpen);
    socket.removeEventListener("message", this.handleMessage);
    socket.removeEventListener("error", this.handleError);
    socket.removeEventListener("close", this.handleClose);
  }
}

function withAuthToken(url: string, authToken: string | undefined): string {
  if (authToken === undefined) {
    return url;
  }

  const parsed = new URL(url);
  parsed.searchParams.set("tau_token", authToken);
  return parsed.toString();
}

function readMessageEventData(event: unknown): unknown {
  if (typeof event === "object" && event !== null && "data" in event) {
    return event.data;
  }
  return undefined;
}

async function waitForCloseOrTimeout(
  closePromise: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  await waitForPromiseOrTimeout(closePromise, timeoutMs);
}
