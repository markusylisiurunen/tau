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

export type DiffToolBrief = {
  threadId?: string;
  content: string;
  loading: boolean;
};

export type DiffToolReviewState = {
  diffStyle: "stacked" | "split";
  overflowMode: "wrap" | "scroll";
  codeTheme: DiffToolCodeTheme;
  sidebarOpen: boolean;
  collapsedFileIds: string[];
  viewedFileIds: string[];
  threads: DiffToolCommentThread[];
  brief: DiffToolBrief;
};

export type DiffToolStatePatch = {
  diffStyle?: DiffToolReviewState["diffStyle"];
  overflowMode?: DiffToolReviewState["overflowMode"];
  codeTheme?: DiffToolReviewState["codeTheme"];
  sidebarOpen?: boolean;
  collapsedFileIds?: string[];
  viewedFileIds?: string[];
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
