export type SessionAttributes = Record<string, string>;
export type HistoryAttributeFilter = string | { contains: string };
export type HistoryAttributeFilters = Record<string, HistoryAttributeFilter>;

type HistoryEntryBase = {
  id: string;
  sourceIds: string[];
  timestamp: number;
};

export type HistoryUserContent =
  | string
  | Array<
      | { type: "text"; text: string; textSignature?: string }
      | { type: "image"; data: string; mimeType: string }
    >;

export type HistoryTextEntry =
  | (HistoryEntryBase & { type: "user"; content: HistoryUserContent })
  | (HistoryEntryBase & { type: "assistant"; content: string });

export type HistoryToolEntry = HistoryEntryBase & {
  type: "tool";
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
  webUrl?: string;
  digest?: HistoryDigest;
  snippets: string[];
};

export type HistorySearchInput = {
  query?: string;
  attributes?: HistoryAttributeFilters;
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
