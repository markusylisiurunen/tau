export type SessionAttributes = Record<string, string>;

export type HistoryTextEntry = {
  id: string;
  sourceIds: string[];
  type: "user" | "assistant";
  timestamp: number;
  content: unknown;
};

export type HistoryToolEntry = {
  id: string;
  sourceIds: string[];
  type: "tool";
  timestamp: number;
  name: string;
  arguments: unknown;
  result: unknown;
  outcome: "succeeded" | "failed" | "blocked" | "cancelled";
};

export type HistoryEntry = HistoryTextEntry | HistoryToolEntry;

export type HistoryDigest = {
  title: string;
  summary: string;
  updatedThroughEntryId: string;
};

export type HistorySessionDescriptor = {
  sessionId: string;
  attributes: SessionAttributes;
  createdAt: number;
  updatedAt: number;
  digest?: HistoryDigest;
  snippets: string[];
};

export type HistorySearchInput = {
  query?: string;
  attributes?: SessionAttributes;
  limit: number;
  cursor?: string;
};

export type HistorySearchResult = {
  sessions: HistorySessionDescriptor[];
  nextCursor?: string;
};

export type HistoryReadInput = {
  sessionId: string;
  limit: number;
  cursor?: string;
};

export type HistoryReadResult = {
  session: HistorySessionDescriptor;
  entries: HistoryEntry[];
  nextCursor?: string;
};

export type HistoryRemoteTarget = {
  endpoint: string;
  apiKey: string;
};

export type HistorySessionRecord = {
  sessionId: string;
  attributes: SessionAttributes;
  createdAt: number;
};

export type HistoryReplicationOperation =
  | {
      id: string;
      sessionId: string;
      type: "create";
      session: HistorySessionRecord;
    }
  | {
      id: string;
      sessionId: string;
      type: "append";
      entries: HistoryEntry[];
    }
  | {
      id: string;
      sessionId: string;
      type: "truncate";
      afterEntryId: string | null;
    };

export interface HistoryQuery {
  search(input: HistorySearchInput, signal?: AbortSignal): Promise<HistorySearchResult>;
  read(input: HistoryReadInput, signal?: AbortSignal): Promise<HistoryReadResult>;
}
