import type { TauSessionHost } from "../host/session_host.js";
import { SessionProtocolHandler } from "../host/session_protocol_handler.js";
import type {
  SessionProtocolInitializeParams,
  SessionProtocolMethod,
  SessionProtocolOutgoingMessage,
  SessionProtocolParamsByMethod,
  SessionProtocolReadyMessage,
  SessionProtocolResultByMethod,
} from "../protocol/session_protocol.js";
import { TauTransportError } from "./errors.js";
import {
  type PendingSessionProtocolRequest,
  PendingSessionProtocolRequests,
} from "./pending_session_protocol_requests.js";
import {
  handleSessionProtocolTransportResponse,
  notifySessionProtocolClientToolListeners,
  notifySessionProtocolDeltaListeners,
  notifySessionProtocolEphemeralListeners,
  notifySessionProtocolPendingUserMessagesListeners,
  notifySessionProtocolSubagentActivitiesListeners,
} from "./session_protocol_transport_helpers.js";
import type {
  SessionProtocolClientToolListener,
  SessionProtocolDeltaListener,
  SessionProtocolEphemeralListener,
  SessionProtocolFailureListener,
  SessionProtocolPendingUserMessagesListener,
  SessionProtocolSubagentActivitiesListener,
  SessionProtocolTransport,
} from "./session_transport.js";

export type InProcessSessionProtocolTransportOptions = {
  host: TauSessionHost;
  closeMode?: "detach" | "shutdown-host";
};

export class InProcessSessionProtocolTransport implements SessionProtocolTransport {
  private readonly handler: SessionProtocolHandler;
  private readonly closeMode: "detach" | "shutdown-host";
  private readonly deltaListeners = new Set<SessionProtocolDeltaListener>();
  private readonly ephemeralListeners = new Set<SessionProtocolEphemeralListener>();
  private readonly pendingUserMessagesListeners =
    new Set<SessionProtocolPendingUserMessagesListener>();
  private readonly subagentActivitiesListeners =
    new Set<SessionProtocolSubagentActivitiesListener>();
  private readonly clientToolListeners = new Set<SessionProtocolClientToolListener>();
  private readonly pendingRequests = new PendingSessionProtocolRequests();

  private readyValue?: SessionProtocolReadyMessage;
  private connectPromise?: Promise<void>;
  private isConnected = false;
  private isClosed = false;

  constructor(options: InProcessSessionProtocolTransportOptions) {
    this.closeMode = options.closeMode ?? "detach";
    this.handler = new SessionProtocolHandler({
      host: options.host,
      send: (message) => this.handleMessage(message),
    });
  }

  get ready(): SessionProtocolReadyMessage {
    if (!this.isConnected || !this.readyValue) {
      throw new TauTransportError("tau in-process transport is not connected");
    }

    return this.readyValue;
  }

  async connect(
    initializeParams: SessionProtocolInitializeParams,
    timeoutMs: number,
  ): Promise<void> {
    void timeoutMs;

    if (this.isClosed) {
      throw new TauTransportError("tau in-process transport is closed");
    }

    if (this.isConnected) {
      return;
    }

    this.connectPromise ??= this.establishConnection(initializeParams);
    await this.connectPromise;
  }

  private async establishConnection(
    initializeParams: SessionProtocolInitializeParams,
  ): Promise<void> {
    await this.request("initialize", initializeParams);
    this.isConnected = true;
  }

  request<M extends SessionProtocolMethod>(
    method: M,
    params: SessionProtocolParamsByMethod[M],
  ): Promise<SessionProtocolResultByMethod[M]> {
    if (this.isClosed) {
      return Promise.reject(new TauTransportError("tau in-process transport is closed"));
    }

    let pending: PendingSessionProtocolRequest<M>;
    try {
      pending = this.pendingRequests.create(method, params);
    } catch (error) {
      return Promise.reject(error);
    }

    void this.handler.handleRequest(pending.request).catch((error) => {
      this.pendingRequests.reject(pending.request.id, error);
    });

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

  onPendingUserMessages(listener: SessionProtocolPendingUserMessagesListener): () => void {
    this.pendingUserMessagesListeners.add(listener);
    return () => {
      this.pendingUserMessagesListeners.delete(listener);
    };
  }

  onSubagentActivities(listener: SessionProtocolSubagentActivitiesListener): () => void {
    this.subagentActivitiesListeners.add(listener);
    return () => {
      this.subagentActivitiesListeners.delete(listener);
    };
  }

  onClientTool(listener: SessionProtocolClientToolListener): () => void {
    this.clientToolListeners.add(listener);
    return () => {
      this.clientToolListeners.delete(listener);
    };
  }

  onFailure(_listener: SessionProtocolFailureListener): () => void {
    return () => undefined;
  }

  async close(): Promise<void> {
    if (this.isClosed) {
      return;
    }

    this.isClosed = true;
    const closeError = new TauTransportError("tau in-process transport was closed");
    this.pendingRequests.rejectAll(closeError);
    this.deltaListeners.clear();
    this.ephemeralListeners.clear();
    this.pendingUserMessagesListeners.clear();
    this.subagentActivitiesListeners.clear();
    this.clientToolListeners.clear();
    await this.handler.close(this.closeMode);
  }

  private handleMessage(message: SessionProtocolOutgoingMessage): void {
    if (message.type === "ready") {
      this.readyValue = message;
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

    if (message.type === "session.pendingUserMessages") {
      notifySessionProtocolPendingUserMessagesListeners(
        this.pendingUserMessagesListeners,
        message,
        {
          ignoreListenerErrors: true,
        },
      );
      return;
    }

    if (message.type === "session.subagentActivities") {
      notifySessionProtocolSubagentActivitiesListeners(this.subagentActivitiesListeners, message, {
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

    handleSessionProtocolTransportResponse(message, this.pendingRequests, () => undefined);
  }
}
