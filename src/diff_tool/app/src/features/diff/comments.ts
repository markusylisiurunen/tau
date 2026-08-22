import type { DiffLineAnnotation } from "@pierre/diffs/react";
import type {
  DiffToolCommentThread,
  DiffToolThreadMessage,
  LineSide,
} from "../../types.js";

export type { LineSide };

export type ThreadMessage = DiffToolThreadMessage;
export type CommentThread = DiffToolCommentThread;

export type CommentDraft = {
  fileId: string;
  lineNumber: number;
  side: LineSide;
};

export type CommentAnnotation =
  | { type: "thread"; thread: CommentThread }
  | { type: "draft"; draft: CommentDraft };

export type LineAnnotation = DiffLineAnnotation<CommentAnnotation>;
