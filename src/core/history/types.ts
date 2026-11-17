import type { z } from "zod";
import type {
  historyEntrySchema,
  historySessionDescriptorSchema,
  userContentSchema,
} from "./schema.js";

export type SessionAttributes = Record<string, string>;
export type HistoryAttributeFilter = string | { contains: string };
export type HistoryAttributeFilters = Record<string, HistoryAttributeFilter>;

export type HistoryUserContent = z.infer<typeof userContentSchema>;
export type HistoryEntry = z.infer<typeof historyEntrySchema>;
export type HistoryTextEntry = Exclude<HistoryEntry, { type: "tool" }>;
export type HistoryToolEntry = Extract<HistoryEntry, { type: "tool" }>;

export type HistoryDigest = {
  title: string;
  summary: string;
  updatedThroughEntryId: string;
};

export type HistorySessionDescriptor = z.infer<typeof historySessionDescriptorSchema>;

// Absent means "none": only sessions without a parent.
export type HistorySearchParent = "none" | "any" | { sessionId: string };

export type HistoryTimeRange = {
  field: "createdAt" | "updatedAt";
  since?: number;
  until?: number;
};

export type HistorySearchInput = {
  order?: "sessionId";
  query?: string;
  attributes?: HistoryAttributeFilters;
  parent?: HistorySearchParent;
  timeRange?: HistoryTimeRange;
  limit: number;
  cursor?: string;
};

export type HistorySearchResult = {
  sessions: HistorySessionDescriptor[];
  nextCursor?: string;
};

export type HistoryReadInput = {
  sessionId: string;
  source?: "local";
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
  parentSessionId?: string;
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
