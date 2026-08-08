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
  SessionProtocolSubagentActivitiesMessage,
} from "../protocol/session_protocol.js";

export type SessionProtocolDeltaListener = (delta: SessionProtocolDeltaMessage) => void;
export type SessionProtocolEphemeralListener = (message: SessionProtocolEphemeralMessage) => void;
export type SessionProtocolPendingUserMessagesListener = (
  message: SessionProtocolPendingUserMessagesMessage,
) => void;
export type SessionProtocolSubagentActivitiesListener = (
  message: SessionProtocolSubagentActivitiesMessage,
) => void;
export type SessionProtocolClientToolListener = (message: SessionProtocolClientToolMessage) => void;
export type SessionProtocolFailureListener = (error: Error) => void;

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
  onSubagentActivities(listener: SessionProtocolSubagentActivitiesListener): () => void;
  onClientTool(listener: SessionProtocolClientToolListener): () => void;
  onFailure(listener: SessionProtocolFailureListener): () => void;
  close(): Promise<void>;
};
