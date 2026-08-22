import {
  DEFAULT_DIFF_TOOL_CODE_THEME,
  DIFF_TOOL_CODE_THEMES,
  type DiffToolReviewState,
} from "../../types.js";

export const emptyReviewState: DiffToolReviewState = {
  diffStyle: "stacked",
  overflowMode: "wrap",
  codeTheme: DEFAULT_DIFF_TOOL_CODE_THEME,
  collapsedFileIds: [],
  viewedFileIds: [],
  threads: [],
  guide: {
    orientation: "",
    topics: [],
    questions: [],
    comments: [],
    loading: false,
  },
};

const codeThemes = new Set<DiffToolReviewState["codeTheme"]>(
  DIFF_TOOL_CODE_THEMES,
);

export function normalizeReviewState(
  state: DiffToolReviewState,
): DiffToolReviewState {
  return {
    ...state,
    diffStyle: state.diffStyle === "split" ? "split" : "stacked",
    overflowMode: state.overflowMode === "scroll" ? "scroll" : "wrap",
    codeTheme: normalizeCodeTheme(state.codeTheme),
    threads: state.threads.map((thread) => ({
      ...thread,
      anchor:
        thread.anchor.kind === "line"
          ? { ...thread.anchor }
          : { kind: "detached" as const },
      resolved: Boolean(thread.resolved),
      collapsed: Boolean(thread.collapsed),
    })),
    guide: {
      ...(state.guide.threadId ? { threadId: state.guide.threadId } : {}),
      orientation: state.guide.orientation,
      topics: state.guide.topics.map((topic) => ({ ...topic })),
      questions: state.guide.questions.map((question) => ({ ...question })),
      comments: state.guide.comments.map((comment) => ({
        ...comment,
        target: { ...comment.target },
      })),
      loading: Boolean(state.guide.loading),
    },
  };
}

export function withThreadLoading(
  state: DiffToolReviewState,
  threadId: string,
  loading: boolean,
): DiffToolReviewState {
  return {
    ...state,
    threads: state.threads.map((thread) =>
      thread.id === threadId ? { ...thread, loading } : thread,
    ),
  };
}

export function withGuideLoading(
  state: DiffToolReviewState,
  loading: boolean,
): DiffToolReviewState {
  return {
    ...state,
    guide: {
      ...state.guide,
      loading,
    },
  };
}

function normalizeCodeTheme(
  codeTheme: DiffToolReviewState["codeTheme"],
): DiffToolReviewState["codeTheme"] {
  return codeThemes.has(codeTheme) ? codeTheme : DEFAULT_DIFF_TOOL_CODE_THEME;
}
