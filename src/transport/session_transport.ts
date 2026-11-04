import type {
  SessionProtocolClientToolMessage,
  SessionProtocolDeltaMessage,
  SessionProtocolEphemeralMessage,
  SessionProtocolInitializeParams,
  SessionProtocolMethod,
  SessionProtocolObservationEndedMessage,
  SessionProtocolObservedMessage,
  SessionProtocolParamsByMethod,
  SessionProtocolPendingUserMessagesMessage,
  SessionProtocolReadyMessage,
  SessionProtocolResultByMethod,
  SessionProtocolSubagentActivitiesMessage,
} from "../protocol/session_protocol.js";

export type SessionProtocolDeltaListener = (
  delta: SessionProtocolObservedMessage<SessionProtocolDeltaMessage>,
) => void;
export type SessionProtocolEphemeralListener = (
  message: SessionProtocolObservedMessage<SessionProtocolEphemeralMessage>,
) => void;
export type SessionProtocolPendingUserMessagesListener = (
  message: SessionProtocolObservedMessage<SessionProtocolPendingUserMessagesMessage>,
) => void;
export type SessionProtocolSubagentActivitiesListener = (
  message: SessionProtocolObservedMessage<SessionProtocolSubagentActivitiesMessage>,
) => void;
export type SessionProtocolClientToolListener = (message: SessionProtocolClientToolMessage) => void;
export type SessionProtocolObservationEndedListener = (
  message: SessionProtocolObservationEndedMessage,
) => void;
export type SessionProtocolFailureListener = (error: Error) => void;

export type SessionProtocolTransport = {
  readonly ready: SessionProtocolReadyMessage;
  connect(initializeParams: SessionProtocolInitializeParams, timeoutMs: number): Promise<void>;
  request<M extends SessionProtocolMethod>(
    method: M,
    params: SessionProtocolParamsByMethod[M],
    observationId?: string,
  ): Promise<SessionProtocolResultByMethod[M]>;
  onDelta(listener: SessionProtocolDeltaListener): () => void;
  onEphemeral(listener: SessionProtocolEphemeralListener): () => void;
  onPendingUserMessages(listener: SessionProtocolPendingUserMessagesListener): () => void;
  onSubagentActivities(listener: SessionProtocolSubagentActivitiesListener): () => void;
  onClientTool(listener: SessionProtocolClientToolListener): () => void;
  onObservationEnded(listener: SessionProtocolObservationEndedListener): () => void;
  onFailure(listener: SessionProtocolFailureListener): () => void;
  close(): Promise<void>;
};
