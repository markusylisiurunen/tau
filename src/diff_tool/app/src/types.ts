import type {
  DiffReviewFile,
  DiffToolBootstrapPayload,
  DiffToolCreateThreadPayload,
  DiffToolGetDiffResult,
  DiffToolReviewState,
  DiffToolStateResponse,
  DiffToolThreadReplyPayload,
} from "../../shared_types.js";

export type { DiffReviewFile, DiffToolReviewState };

export type BootstrapPayload = DiffToolBootstrapPayload;
export type DiffReviewGetDiffResult = DiffToolGetDiffResult;
export type StateResponse = DiffToolStateResponse;
export type CreateThreadPayload = DiffToolCreateThreadPayload;
export type ThreadReplyPayload = DiffToolThreadReplyPayload;
