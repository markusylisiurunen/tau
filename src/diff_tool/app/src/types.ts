import {
  DEFAULT_DIFF_TOOL_CODE_THEME,
  DIFF_TOOL_CODE_THEMES,
} from "../../shared_types.js";
import type {
  DiffReviewFile,
  DiffToolBootstrapPayload,
  DiffToolBrief,
  DiffToolCommentThread,
  DiffToolCreateThreadPayload,
  DiffToolCreateThreadResponse,
  DiffToolDeleteThreadMessagePayload,
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

export { DEFAULT_DIFF_TOOL_CODE_THEME, DIFF_TOOL_CODE_THEMES };

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
export type CreateThreadResponse = DiffToolCreateThreadResponse;
export type ThreadReplyPayload = DiffToolThreadReplyPayload;
export type DeleteThreadMessagePayload = DiffToolDeleteThreadMessagePayload;
export type LineSide = DiffToolLineSide;
export type DiffStyle = DiffToolReviewState["diffStyle"];
export type OverflowMode = DiffToolReviewState["overflowMode"];
export type CodeTheme = DiffToolReviewState["codeTheme"];

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
