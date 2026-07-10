import type {
  SessionProtocolClientToolMessage,
  SessionProtocolDeltaMessage,
  SessionProtocolEphemeralMessage,
  SessionProtocolInitializeParams,
  SessionProtocolMethod,
  SessionProtocolParamsByMethod,
  SessionProtocolPendingUserMessagesMessage,
  SessionProtocolReadyMessage,
  SessionProtocolResultByMethod,
} from "../protocol/session_protocol.js";

export type SessionProtocolDeltaListener = (delta: SessionProtocolDeltaMessage) => void;
export type SessionProtocolEphemeralListener = (message: SessionProtocolEphemeralMessage) => void;
export type SessionProtocolPendingUserMessagesListener = (
  message: SessionProtocolPendingUserMessagesMessage,
) => void;
export type SessionProtocolClientToolListener = (message: SessionProtocolClientToolMessage) => void;

export type SessionProtocolTransport = {
  readonly ready: SessionProtocolReadyMessage;
  connect(initializeParams: SessionProtocolInitializeParams, timeoutMs: number): Promise<void>;
  request<M extends SessionProtocolMethod>(
    method: M,
    params: SessionProtocolParamsByMethod[M],
  ): Promise<SessionProtocolResultByMethod[M]>;
  onDelta(listener: SessionProtocolDeltaListener): () => void;
  onEphemeral(listener: SessionProtocolEphemeralListener): () => void;
  onPendingUserMessages(listener: SessionProtocolPendingUserMessagesListener): () => void;
  onClientTool(listener: SessionProtocolClientToolListener): () => void;
  close(): Promise<void>;
};
