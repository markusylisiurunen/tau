import {
  TOOL_CARD_MAX_LINE_CHARS,
  TOOL_CARD_SUBJECT_MAX_LINES,
  truncateToolText,
} from "../core/tools/presentation.js";

export type TauClientToolPresentationLine = {
  text: string;
  tone?: "added" | "removed";
  wrap?: "word" | "character";
};

export type TauClientToolPresentation = {
  subject?: string;
  subjectWrap?: "word" | "character";
  details?: TauClientToolPresentationLine[];
  metadata?: string[];
};

export type TauClientToolTextTruncationOptions = {
  maxLines?: number;
  maxLineChars?: number;
  strategy?: "head" | "middle";
};

export function truncateTauClientToolText(
  text: string,
  options: TauClientToolTextTruncationOptions = {},
): string {
  return truncateToolText(text, {
    maxLines: options.maxLines ?? TOOL_CARD_SUBJECT_MAX_LINES,
    maxLineChars: options.maxLineChars ?? TOOL_CARD_MAX_LINE_CHARS,
    strategy: options.strategy,
  });
}
