import {
  DEFAULT_DIFF_TOOL_CODE_THEME,
  guideCommentTargetKey,
  hasDiffToolReviewComments,
} from "../../shared_types.js";
import type {
  DiffReviewFile,
  DiffToolBootstrapPayload,
  DiffToolCommentThread,
  DiffToolGuide,
  DiffToolGuideComment,
  DiffToolGuideCommentPayload,
  DiffToolGuideCommentTarget,
  DiffToolGuideOperation,
  DiffToolGuideQuestion,
  DiffToolGuideTopic,
  DiffToolCreateThreadPayload,
  DiffToolCreateThreadResponse,
  DiffToolDeleteThreadMessagePayload,
  DiffToolDetachedThreadAnchor,
  DiffToolGetDiffResult,
  DiffToolLineSide,
  DiffToolLineThreadAnchor,
  DiffToolReviewPreview,
  DiffToolReviewPreviewItem,
  DiffToolReviewState,
  DiffToolStatePatch,
  DiffToolStateResponse,
  DiffToolThreadAnchor,
  DiffToolThreadMessage,
  DiffToolThreadReplyPayload,
} from "../../shared_types.js";

export {
  DEFAULT_DIFF_TOOL_CODE_THEME,
  guideCommentTargetKey,
  hasDiffToolReviewComments,
};

export type {
  DiffReviewFile,
  DiffToolCommentThread,
  DiffToolGuide,
  DiffToolGuideComment,
  DiffToolGuideCommentTarget,
  DiffToolGuideOperation,
  DiffToolGuideQuestion,
  DiffToolGuideTopic,
  DiffToolDetachedThreadAnchor,
  DiffToolLineThreadAnchor,
  DiffToolReviewPreview,
  DiffToolReviewPreviewItem,
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
export type GuideCommentPayload = DiffToolGuideCommentPayload;
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
