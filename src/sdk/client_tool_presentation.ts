import { buildToolRunPresentation, truncateToolRunSubject } from "../core/tools/presentation.js";

export type TauClientToolPresentationStatus =
  | "preparing"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled";

export type TauClientToolPresentationActionLabels = Record<TauClientToolPresentationStatus, string>;

export type TauClientToolPresentationLine = {
  text: string;
  tone?: "added" | "removed";
  wrap: "word" | "character";
};

export type TauClientToolPresentation = {
  actionByStatus: TauClientToolPresentationActionLabels;
  operation?: string;
  subject: string;
  subjectWrap: "word" | "character";
  details: TauClientToolPresentationLine[];
  metadata: string[];
};

export type BuildTauClientToolPresentationOptions = {
  toolName: string;
  operation?: string;
  subject: string;
  subjectWrap?: "word" | "character";
  details?: Array<{
    text: string;
    tone?: "added" | "removed";
    wrap?: "word" | "character";
  }>;
  detailTruncation?:
    | false
    | {
        maxLines: number;
        maxLineChars: number;
        strategy: "head" | "middle";
      };
  metadata?: string[];
  actionOverrides?: Partial<TauClientToolPresentationActionLabels>;
};

export type TauClientToolSubjectTruncationOptions = {
  maxLines?: number;
  maxLineChars?: number;
  strategy?: "head" | "middle";
};

export function buildTauClientToolPresentation(
  options: BuildTauClientToolPresentationOptions,
): TauClientToolPresentation {
  return buildToolRunPresentation(options);
}

export function truncateTauClientToolSubject(
  subject: string,
  options: TauClientToolSubjectTruncationOptions = {},
): string {
  return truncateToolRunSubject(subject, options);
}
