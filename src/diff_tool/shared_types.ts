import type {
  DiffReviewFile,
  DiffReviewSessionContextResult,
  DiffReviewSessionGetDiffResult,
} from "../core/diff_review/index.js";

export type { DiffReviewFile };

export type DiffToolThreadMessage = {
  role: "user" | "assistant";
  text: string;
};

export type DiffToolLineSide = "additions" | "deletions";

export type DiffToolDetachedThreadAnchor = {
  kind: "detached";
};

export type DiffToolLineThreadAnchor = {
  kind: "line";
  fileId: string;
  filePath: string;
  lineNumber: number;
  side: DiffToolLineSide;
};

export type DiffToolThreadAnchor = DiffToolDetachedThreadAnchor | DiffToolLineThreadAnchor;

export type DiffToolCommentThread = {
  id: string;
  threadId?: string;
  anchor: DiffToolThreadAnchor;
  messages: DiffToolThreadMessage[];
  loading: boolean;
  resolved: boolean;
  collapsed: boolean;
};

export type DiffToolBrief = {
  threadId?: string;
  content: string;
  loading: boolean;
};

export type DiffToolReviewState = {
  diffStyle: "stacked" | "split";
  overflowMode: "wrap" | "scroll";
  sidebarOpen: boolean;
  collapsedFileIds: string[];
  viewedFileIds: string[];
  threads: DiffToolCommentThread[];
  brief: DiffToolBrief;
};

export type DiffToolStatePatch = {
  diffStyle?: DiffToolReviewState["diffStyle"];
  overflowMode?: DiffToolReviewState["overflowMode"];
  sidebarOpen?: boolean;
  collapsedFileIds?: string[];
  viewedFileIds?: string[];
};

export type DiffToolBootstrapPayload = {
  context: DiffReviewSessionContextResult;
  files: DiffReviewFile[];
  state: DiffToolReviewState;
};

export type DiffToolGetDiffResult = DiffReviewSessionGetDiffResult;

export type DiffToolStateResponse = {
  state: DiffToolReviewState;
};

export type DiffToolCreateThreadPayload = {
  anchor: DiffToolThreadAnchor;
  body: string;
};

export type DiffToolThreadReplyPayload = {
  id: string;
  text: string;
};
