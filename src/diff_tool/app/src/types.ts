import type {
  DiffReviewFile,
  DiffToolBootstrapPayload,
  DiffToolBrief,
  DiffToolCommentThread,
  DiffToolCreateThreadPayload,
  DiffToolGetDiffResult,
  DiffToolLineSide,
  DiffToolReviewState,
  DiffToolStatePatch,
  DiffToolStateResponse,
  DiffToolThreadMessage,
  DiffToolThreadReplyPayload,
} from "../../shared_types.js";

export type {
  DiffReviewFile,
  DiffToolBrief,
  DiffToolCommentThread,
  DiffToolReviewState,
  DiffToolThreadMessage,
};

export type BootstrapPayload = DiffToolBootstrapPayload;
export type DiffReviewGetDiffResult = DiffToolGetDiffResult;
export type StateResponse = DiffToolStateResponse;
export type ReviewStatePatch = DiffToolStatePatch;
export type CreateThreadPayload = DiffToolCreateThreadPayload;
export type ThreadReplyPayload = DiffToolThreadReplyPayload;
export type LineSide = DiffToolLineSide;
export type DiffStyle = DiffToolReviewState["diffStyle"];
export type OverflowMode = DiffToolReviewState["overflowMode"];

export type ResolveThreadPayload = {
  id: string;
  resolved: boolean;
};

export type CollapseThreadPayload = {
  id: string;
  collapsed: boolean;
};

export type GenerateBriefResponse = {
  state: DiffToolReviewState;
};
