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

export const DIFF_TOOL_CODE_THEMES = [
  "andromeeda",
  "aurora-x",
  "ayu-dark",
  "ayu-mirage",
  "catppuccin-frappe",
  "catppuccin-macchiato",
  "catppuccin-mocha",
  "dark-plus",
  "dracula",
  "dracula-soft",
  "everforest-dark",
  "github-dark",
  "github-dark-default",
  "github-dark-dimmed",
  "github-dark-high-contrast",
  "gruvbox-dark-hard",
  "gruvbox-dark-medium",
  "gruvbox-dark-soft",
  "horizon",
  "horizon-bright",
  "houston",
  "kanagawa-dragon",
  "kanagawa-wave",
  "laserwave",
  "material-theme",
  "material-theme-darker",
  "material-theme-ocean",
  "material-theme-palenight",
  "min-dark",
  "monokai",
  "night-owl",
  "nord",
  "one-dark-pro",
  "plastic",
  "poimandres",
  "red",
  "rose-pine",
  "rose-pine-moon",
  "slack-dark",
  "solarized-dark",
  "synthwave-84",
  "tokyo-night",
  "vesper",
  "vitesse-black",
  "vitesse-dark",
] as const;

export type DiffToolCodeTheme = (typeof DIFF_TOOL_CODE_THEMES)[number];

export const DEFAULT_DIFF_TOOL_CODE_THEME: DiffToolCodeTheme = "github-dark-dimmed";

export type DiffToolDetachedThreadAnchor = {
  kind: "detached";
};

export type DiffToolLineThreadAnchor = {
  kind: "line";
  fileId: string;
  filePath: string;
  lineNumber: number;
  side: DiffToolLineSide;
};

export type DiffToolThreadAnchor = DiffToolDetachedThreadAnchor | DiffToolLineThreadAnchor;

export type DiffToolCommentThread = {
  id: string;
  threadId?: string;
  anchor: DiffToolThreadAnchor;
  messages: DiffToolThreadMessage[];
  loading: boolean;
  resolved: boolean;
  collapsed: boolean;
};

export const DIFF_TOOL_GUIDE_TOPIC_LIMIT = 24;
export const DIFF_TOOL_GUIDE_QUESTION_LIMIT = 32;

export type DiffToolGuideTopic = {
  id: string;
  label: string;
  heading: string;
  body: string;
};

export type DiffToolGuideQuestion = {
  id: string;
  question: string;
  answer: string;
  source: "generated" | "user";
};

export type DiffToolGuideCommentTarget =
  | { kind: "orientation" }
  | { kind: "topic"; topicId: string }
  | { kind: "question"; questionId: string };

export type DiffToolGuideComment = {
  target: DiffToolGuideCommentTarget;
  body: string;
};

export function guideCommentTargetKey(target: DiffToolGuideCommentTarget): string {
  switch (target.kind) {
    case "orientation":
      return "orientation";
    case "topic":
      return `topic:${target.topicId}`;
    case "question":
      return `question:${target.questionId}`;
  }
}

export type DiffToolGuide = {
  threadId?: string;
  orientation: string;
  topics: DiffToolGuideTopic[];
  questions: DiffToolGuideQuestion[];
  comments: DiffToolGuideComment[];
  loading: boolean;
};

export type DiffToolReviewState = {
  diffStyle: "stacked" | "split";
  overflowMode: "wrap" | "scroll";
  codeTheme: DiffToolCodeTheme;
  collapsedFileIds: string[];
  viewedFileIds: string[];
  threads: DiffToolCommentThread[];
  guide: DiffToolGuide;
};

export function hasDiffToolReviewComments(state: DiffToolReviewState): boolean {
  return state.guide.comments.length > 0 || state.threads.some((thread) => !thread.resolved);
}

export type DiffToolStatePatch = {
  diffStyle?: DiffToolReviewState["diffStyle"];
  overflowMode?: DiffToolReviewState["overflowMode"];
  codeTheme?: DiffToolReviewState["codeTheme"];
  collapsedFileIds?: string[];
  viewedFileIds?: string[];
};

export type DiffToolGuideOperation =
  | { kind: "topic.add"; request: string }
  | { kind: "topic.revise"; topicId: string; request: string }
  | { kind: "question.ask"; question: string };

export type DiffToolGuideOperationResult =
  | { kind: "topic.add" | "topic.revise"; topic: Omit<DiffToolGuideTopic, "id"> }
  | {
      kind: "question.ask";
      question: Omit<DiffToolGuideQuestion, "id" | "source">;
    };

export type DiffToolGuideCommentPayload = {
  target: DiffToolGuideCommentTarget;
  body: string;
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

export type DiffToolCreateThreadResponse = DiffToolStateResponse & {
  threadId: string;
};

export type DiffToolCreateThreadPayload = {
  anchor: DiffToolThreadAnchor;
  body: string;
};

export type DiffToolThreadReplyPayload = {
  id: string;
  text: string;
};

export type DiffToolDeleteThreadMessagePayload = {
  id: string;
  messageIndex: number;
};
