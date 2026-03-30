import type { DiffLineAnnotation } from "@pierre/diffs/react";

export type LineSide = "additions" | "deletions";

export type ThreadMessage = {
  role: "user" | "assistant";
  text: string;
};

export type CommentThread = {
  id: string;
  threadId?: string;
  fileId: string;
  filePath: string;
  lineNumber: number;
  side: LineSide;
  messages: ThreadMessage[];
  loading: boolean;
};

export type CommentDraft = {
  fileId: string;
  lineNumber: number;
  side: LineSide;
  body: string;
};

export type CommentAnnotation =
  | { type: "thread"; thread: CommentThread }
  | { type: "draft"; draft: CommentDraft };

export type LineAnnotation = DiffLineAnnotation<CommentAnnotation>;
