import type {
  DiffReviewFile,
  DiffToolBootstrapPayload,
  DiffToolBrief,
  DiffToolCommentThread,
  DiffToolCreateThreadPayload,
  DiffToolDetachedThreadAnchor,
  DiffToolGetDiffResult,
  DiffToolLineSide,
  DiffToolLineThreadAnchor,
  DiffToolReviewState,
  DiffToolStatePatch,
  DiffToolStateResponse,
  DiffToolThreadAnchor,
  DiffToolThreadMessage,
  DiffToolThreadReplyPayload,
} from "../../shared_types.js";

export type {
  DiffReviewFile,
  DiffToolBrief,
  DiffToolCommentThread,
  DiffToolDetachedThreadAnchor,
  DiffToolLineThreadAnchor,
  DiffToolReviewState,
  DiffToolThreadAnchor,
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
export type SidebarWidth = DiffToolReviewState["sidebarWidth"];

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
