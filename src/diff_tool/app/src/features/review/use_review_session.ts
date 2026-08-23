import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchBootstrap, fetchDiff, updateReviewState } from "../../api.js";
import type {
  BootstrapPayload,
  DiffReviewGetDiffResult,
  DiffToolReviewState,
  ReviewStatePatch,
  StateResponse,
} from "../../types.js";
import { parseDiff } from "../diff/parse_diff.js";
import {
  emptyReviewState,
  withGuideLoading,
  withThreadLoading,
} from "./review_state.js";

export type ReviewStateSyncOptions = {
  onError?: () => void;
};

export function useReviewSession() {
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [diff, setDiff] = useState<DiffReviewGetDiffResult | null>(null);
  const [reviewState, setReviewState] =
    useState<DiffToolReviewState>(emptyReviewState);

  const applyReviewState = useCallback((state: DiffToolReviewState) => {
    setReviewState(state);
  }, []);

  const syncReviewState = useCallback(
    async (
      operation: Promise<StateResponse>,
      options: ReviewStateSyncOptions = {},
    ) => {
      try {
        const result = await operation;
        applyReviewState(result.state);
      } catch {
        options.onError?.();
      }
    },
    [applyReviewState],
  );

  const applyStatePatch = useCallback(
    (patch: ReviewStatePatch, options?: ReviewStateSyncOptions) => {
      void syncReviewState(updateReviewState(patch), options);
    },
    [syncReviewState],
  );

  const setThreadLoading = useCallback((threadId: string, loading: boolean) => {
    setReviewState((state) => withThreadLoading(state, threadId, loading));
  }, []);

  const setGuideLoading = useCallback((loading: boolean) => {
    setReviewState((state) => withGuideLoading(state, loading));
  }, []);

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const data = await fetchBootstrap();
        if (!data.state) {
          throw new Error(
            "diff tool bootstrap response did not include review state",
          );
        }
        if (!active) {
          return;
        }

        setBootstrap(data);
        applyReviewState(data.state);

        const result = await fetchDiff();
        if (active) {
          setDiff(result);
        }
      } catch {}
    };

    void load();

    return () => {
      active = false;
    };
  }, [applyReviewState]);

  const patch = diff && "patch" in diff ? diff.patch : "";
  const files = useMemo(
    () => parseDiff(patch, bootstrap?.files, bootstrap?.context.sessionId),
    [bootstrap, patch],
  );
  const emptyContent = diff ? "no changes to review" : "loading…";

  return {
    bootstrap,
    reviewState,
    files,
    emptyContent,
    applyReviewState,
    syncReviewState,
    applyStatePatch,
    setThreadLoading,
    setGuideLoading,
  };
}

export type ReviewSession = ReturnType<typeof useReviewSession>;
