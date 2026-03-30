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

export type DiffToolCommentThread = {
  id: string;
  threadId?: string;
  fileId: string;
  filePath: string;
  lineNumber: number;
  side: DiffToolLineSide;
  messages: DiffToolThreadMessage[];
  loading: boolean;
};

export type DiffToolReviewState = {
  diffStyle: "unified" | "split";
  sidebarOpen: boolean;
  collapsedFileIds: string[];
  viewedFileIds: string[];
  threads: DiffToolCommentThread[];
};

export type DiffToolStatePatch = {
  diffStyle?: DiffToolReviewState["diffStyle"];
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
  fileId: string;
  filePath: string;
  lineNumber: number;
  side: DiffToolLineSide;
  body: string;
};

export type DiffToolThreadReplyPayload = {
  id: string;
  text: string;
};
