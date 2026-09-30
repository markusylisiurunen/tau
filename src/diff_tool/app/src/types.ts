import {
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
  DiffToolReviewSubmissionPayload,
  DiffToolStatePatch,
  DiffToolStateResponse,
  DiffToolThreadAnchor,
  DiffToolThreadMessage,
  DiffToolThreadReplyPayload,
} from "../../shared_types.js";

export { guideCommentTargetKey, hasDiffToolReviewComments };

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
  DiffToolReviewSubmissionPayload,
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

export type ResolveThreadPayload = {
  id: string;
  resolved: boolean;
};

export type CollapseThreadPayload = {
  id: string;
  collapsed: boolean;
};
