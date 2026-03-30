import { useCallback, useEffect, useMemo, useState } from "react";
import "./App.css";
import {
  cancelReview,
  createThread,
  deleteThread,
  fetchBootstrap,
  fetchDiff,
  replyToThread,
  requestThreadMessage,
  returnReview,
  updateReviewState,
} from "./api.js";
import {
  type CommentDraft,
  type LineAnnotation,
  type LineSide,
} from "./comments.js";
import { FileSection } from "./components/file_section.js";
import { Sidebar } from "./components/sidebar.js";
import { TopBar } from "./components/top_bar.js";
import { parseDiff } from "./parse_diff.js";
import type {
  BootstrapPayload,
  DiffReviewGetDiffResult,
  DiffToolReviewState,
} from "./types.js";

const emptyAnnotations: LineAnnotation[] = [];
const emptyReviewState: DiffToolReviewState = {
  diffStyle: "split",
  sidebarOpen: false,
  collapsedFileIds: [],
  viewedFileIds: [],
  threads: [],
};

export function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [diff, setDiff] = useState<DiffReviewGetDiffResult | null>(null);
  const [reviewState, setReviewState] =
    useState<DiffToolReviewState>(emptyReviewState);
  const [draft, setDraft] = useState<CommentDraft | null>(null);
  const [finished, setFinished] = useState(false);
  const [status, setStatus] = useState("");

  const applyReviewState = useCallback((state: DiffToolReviewState) => {
    setReviewState(state);
  }, []);

  const syncState = useCallback(
    async (
      operation: Promise<{ state: DiffToolReviewState }>,
      options: { onError?: () => void } = {},
    ) => {
      try {
        const result = await operation;
        applyReviewState(result.state);
      } catch (error) {
        options.onError?.();
        setStatus(error instanceof Error ? error.message : String(error));
      }
    },
    [applyReviewState],
  );

  useEffect(() => {
    fetchBootstrap()
      .then((data) => {
        if (!data.state) {
          throw new Error(
            "diff tool bootstrap response did not include review state",
          );
        }
        setBootstrap(data);
        applyReviewState(data.state);
        return fetchDiff();
      })
      .then((result) => setDiff(result))
      .catch((error) =>
        setStatus(error instanceof Error ? error.message : String(error)),
      );
  }, [applyReviewState]);

  const patch = diff && "patch" in diff ? diff.patch : "";
  const files = useMemo(
    () => parseDiff(patch, bootstrap?.files, bootstrap?.context.sessionId),
    [patch, bootstrap],
  );

  const collapsed = useMemo(
    () => toLookup(reviewState.collapsedFileIds),
    [reviewState.collapsedFileIds],
  );
  const viewed = useMemo(
    () => toLookup(reviewState.viewedFileIds),
    [reviewState.viewedFileIds],
  );

  const totals = useMemo(
    () =>
      files.reduce(
        (acc, file) => ({
          additions: acc.additions + file.additions,
          deletions: acc.deletions + file.deletions,
        }),
        { additions: 0, deletions: 0 },
      ),
    [files],
  );

  const jumpToFile = useCallback((fileId: string) => {
    const element = document.getElementById(`file-${fileId}`);
    element?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const toggleCollapsed = useCallback(
    (fileId: string) => {
      void syncState(
        updateReviewState({
          collapsedFileIds: toggleId(reviewState.collapsedFileIds, fileId),
        }),
      );
    },
    [reviewState.collapsedFileIds, syncState],
  );

  const toggleViewed = useCallback(
    (fileId: string) => {
      const nextViewed = toggleId(reviewState.viewedFileIds, fileId);
      const isViewed = nextViewed.includes(fileId);
      const nextCollapsed = isViewed
        ? uniqueIds([...reviewState.collapsedFileIds, fileId])
        : reviewState.collapsedFileIds;

      void syncState(
        updateReviewState({
          viewedFileIds: nextViewed,
          collapsedFileIds: nextCollapsed,
        }),
      );
    },
    [reviewState.collapsedFileIds, reviewState.viewedFileIds, syncState],
  );

  const expandAll = useCallback(() => {
    void syncState(updateReviewState({ collapsedFileIds: [] }));
  }, [syncState]);

  const collapseAll = useCallback(() => {
    void syncState(
      updateReviewState({ collapsedFileIds: files.map((file) => file.id) }),
    );
  }, [files, syncState]);

  const collapseViewed = useCallback(() => {
    void syncState(
      updateReviewState({
        collapsedFileIds: uniqueIds([
          ...reviewState.collapsedFileIds,
          ...reviewState.viewedFileIds,
        ]),
      }),
    );
  }, [reviewState.collapsedFileIds, reviewState.viewedFileIds, syncState]);

  const activateLine = useCallback(
    (fileId: string, lineNumber: number, side: LineSide) => {
      setDraft((prev) => {
        if (
          prev &&
          prev.fileId === fileId &&
          prev.lineNumber === lineNumber &&
          prev.side === side
        ) {
          return prev;
        }
        return { fileId, lineNumber, side, body: "" };
      });
    },
    [],
  );

  const updateDraft = useCallback((body: string) => {
    setDraft((prev) => (prev ? { ...prev, body } : prev));
  }, []);

  const saveDraft = useCallback(() => {
    if (!draft) {
      return;
    }

    const body = draft.body.trim();
    if (!body) {
      setDraft(null);
      return;
    }

    const file = files.find((entry) => entry.id === draft.fileId);
    const filePath =
      draft.side === "deletions"
        ? (file?.oldRepoPath ?? file?.newRepoPath ?? draft.fileId)
        : (file?.newRepoPath ?? file?.oldRepoPath ?? draft.fileId);
    void syncState(
      createThread({
        fileId: draft.fileId,
        filePath,
        lineNumber: draft.lineNumber,
        side: draft.side,
        body,
      }).then((result) => {
        setDraft(null);
        return result;
      }),
    );
  }, [draft, files, syncState]);

  const cancelDraft = useCallback(() => setDraft(null), []);

  const removeThread = useCallback(
    (threadId: string) => {
      void syncState(deleteThread(threadId));
    },
    [syncState],
  );

  const addReply = useCallback(
    (threadId: string, text: string) => {
      void syncState(replyToThread({ id: threadId, text }));
    },
    [syncState],
  );

  const requestAgent = useCallback(
    (threadId: string) => {
      setStatus("");
      setReviewState((prev) => ({
        ...prev,
        threads: prev.threads.map((thread) =>
          thread.id === threadId ? { ...thread, loading: true } : thread,
        ),
      }));
      void syncState(requestThreadMessage(threadId), {
        onError: () => {
          setReviewState((prev) => ({
            ...prev,
            threads: prev.threads.map((thread) =>
              thread.id === threadId ? { ...thread, loading: false } : thread,
            ),
          }));
        },
      });
    },
    [syncState],
  );

  const threadsByFileId = useMemo(() => {
    const byFile = new Map<string, LineAnnotation[]>();
    for (const thread of reviewState.threads) {
      const annotation: LineAnnotation = {
        lineNumber: thread.lineNumber,
        side: thread.side,
        metadata: { type: "thread", thread },
      };
      const entry = byFile.get(thread.fileId);
      if (entry) {
        entry.push(annotation);
      } else {
        byFile.set(thread.fileId, [annotation]);
      }
    }
    return byFile;
  }, [reviewState.threads]);

  const draftAnnotation = useMemo<LineAnnotation | null>(() => {
    if (!draft) {
      return null;
    }
    return {
      lineNumber: draft.lineNumber,
      side: draft.side,
      metadata: { type: "draft", draft },
    };
  }, [draft]);

  const handleSubmit = async () => {
    setFinished(true);
    setStatus("Returning review…");
    try {
      await returnReview();
      setStatus("Review returned. You can close this tab.");
    } catch (error) {
      setFinished(false);
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const handleCancel = async () => {
    setFinished(true);
    setStatus("Cancelling…");
    try {
      await cancelReview();
      setStatus("Cancelled. You can close this tab.");
    } catch (error) {
      setFinished(false);
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className={`app${reviewState.sidebarOpen ? " sidebar-open" : ""}`}>
      <TopBar
        fileCount={files.length}
        viewedCount={reviewState.viewedFileIds.length}
        additions={totals.additions}
        deletions={totals.deletions}
        commentCount={reviewState.threads.length}
        diffCommand={bootstrap?.context.diffCommand}
        diffStyle={reviewState.diffStyle}
        sidebarOpen={reviewState.sidebarOpen}
        finished={finished}
        status={status}
        onToggleSidebar={() => {
          void syncState(
            updateReviewState({ sidebarOpen: !reviewState.sidebarOpen }),
          );
        }}
        onExpandAll={expandAll}
        onCollapseViewed={collapseViewed}
        onCollapseAll={collapseAll}
        onDiffStyleChange={(diffStyle) => {
          void syncState(updateReviewState({ diffStyle }));
        }}
        onSubmit={handleSubmit}
        onCancel={handleCancel}
      />
      <Sidebar
        open={reviewState.sidebarOpen}
        files={files}
        viewed={viewed}
        onJumpToFile={jumpToFile}
      />
      <main className="content">
        {files.length === 0 && (
          <div className="empty">{status || "loading…"}</div>
        )}
        {files.map((file) => {
          const fileThreads = threadsByFileId.get(file.id) ?? emptyAnnotations;
          const annotations =
            draft && draft.fileId === file.id && draftAnnotation
              ? [...fileThreads, draftAnnotation]
              : fileThreads;

          return (
            <FileSection
              key={file.id}
              file={file}
              diffStyle={reviewState.diffStyle}
              collapsed={collapsed[file.id] ?? false}
              viewed={viewed[file.id] ?? false}
              annotations={annotations}
              onToggleCollapsed={toggleCollapsed}
              onToggleViewed={toggleViewed}
              onLineActivate={activateLine}
              onDraftChange={updateDraft}
              onSaveDraft={saveDraft}
              onCancelDraft={cancelDraft}
              onDeleteThread={removeThread}
              onAddReply={addReply}
              onRequestAgent={requestAgent}
            />
          );
        })}
      </main>
    </div>
  );
}

function toLookup(ids: string[]): Record<string, boolean> {
  return Object.fromEntries(ids.map((id) => [id, true]));
}

function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id];
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}
