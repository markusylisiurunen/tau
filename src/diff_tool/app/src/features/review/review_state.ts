import {
  DEFAULT_DIFF_TOOL_CODE_THEME,
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
