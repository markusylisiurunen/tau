import {
  type TruncationResult,
  truncateHead,
  truncateMiddle,
  truncateTail,
} from "../../core/utils/truncate.js";

export type UiTruncationStrategy = "head" | "middle" | "tail";

export interface UiTruncationOptions {
  maxLines: number;
  maxTokens?: number;
  strategy?: UiTruncationStrategy;
  marker?: string;
}

export function truncateForUi(content: string, options: UiTruncationOptions): TruncationResult {
  const { strategy = "middle", maxLines, maxTokens, marker } = options;
  if (strategy === "head") {
    return truncateHead(content, { maxLines, maxTokens });
  }
  if (strategy === "tail") {
    return truncateTail(content, { maxLines, maxTokens });
  }
  return truncateMiddle(content, { maxLines, maxTokens, marker });
}

export const BASH_UI_MAX_LINES = 32;
export const BASH_UI_MAX_TOKENS = 5000;

export const READ_UI_MAX_LINES = 32;
export const READ_UI_MAX_TOKENS = 5000;

export const GREP_UI_MAX_LINES = 32;
export const GREP_UI_MAX_TOKENS = 5000;

export const WRITE_UI_PREVIEW_LINES = 16;

export const EDIT_DIFF_MAX_LINES = 200;
export const EDIT_DIFF_MAX_TOKENS = 5000;
