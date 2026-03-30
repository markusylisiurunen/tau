import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "./App.css";
import {
  cancelReview,
  collapseThread,
  createThread,
  fetchBootstrap,
  fetchDiff,
  generateBrief,
  replyToThread,
  requestThreadMessage,
  resolveThread,
  returnReview,
  updateReviewState,
} from "./api.js";
import { type CommentDraft, type LineAnnotation } from "./comments.js";
import {
  buildThreadsByFileId,
  emptyReviewState,
  getAdjacentFileId,
  normalizeReviewState,
  resolveDraftFilePath,
  sumFileChanges,
  toLookup,
  toggleId,
  uniqueIds,
  withBriefLoading,
  withDraftAnnotation,
  withThreadLoading,
} from "./review_state_utils.js";
import { BriefDialog } from "./components/brief_dialog.js";
import { FileSection } from "./components/file_section.js";
import { Sidebar } from "./components/sidebar.js";
import { TopBar } from "./components/top_bar.js";
import { parseDiff } from "./parse_diff.js";
import type {
  BootstrapPayload,
  DiffReviewGetDiffResult,
  DiffToolReviewState,
  ReviewStatePatch,
} from "./types.js";

const emptyAnnotations: LineAnnotation[] = [];

export function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [diff, setDiff] = useState<DiffReviewGetDiffResult | null>(null);
  const [reviewState, setReviewState] =
    useState<DiffToolReviewState>(emptyReviewState);
  const [draft, setDraft] = useState<CommentDraft | null>(null);
  const [finished, setFinished] = useState(false);
  const [status, setStatus] = useState("");
  const [briefOpen, setBriefOpen] = useState(false);
  const pendingCollapsedScrollTargetRef = useRef<string | null>(null);

  const applyReviewState = useCallback((state: DiffToolReviewState) => {
    setReviewState(normalizeReviewState(state));
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

  const applyStatePatch = useCallback(
    (patch: ReviewStatePatch, options?: { onError?: () => void }) => {
      void syncState(updateReviewState(patch), options);
    },
    [syncState],
  );

  const setThreadLoading = useCallback((threadId: string, loading: boolean) => {
    setReviewState((prev) => withThreadLoading(prev, threadId, loading));
  }, []);

  const setBriefLoading = useCallback((loading: boolean) => {
    setReviewState((prev) => withBriefLoading(prev, loading));
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
      } catch (error) {
        if (active) {
          setStatus(error instanceof Error ? error.message : String(error));
        }
      }
    };

    void load();

    return () => {
      active = false;
    };
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
  const unresolvedThreadCount = useMemo(
    () => reviewState.threads.filter((thread) => !thread.resolved).length,
    [reviewState.threads],
  );
  const hasBrief = reviewState.brief.content.trim().length > 0;

  const totals = useMemo(
    () => files.reduce(sumFileChanges, { additions: 0, deletions: 0 }),
    [files],
  );

  const scrollToFile = useCallback(
    (fileId: string, behavior: ScrollBehavior = "smooth") => {
      const element = document.getElementById(`file-${fileId}`);
      element?.scrollIntoView({ behavior, block: "start" });
    },
    [],
  );

  const toggleCollapsed = useCallback(
    (fileId: string) => {
      applyStatePatch({
        collapsedFileIds: toggleId(reviewState.collapsedFileIds, fileId),
      });
    },
    [applyStatePatch, reviewState.collapsedFileIds],
  );

  const toggleViewed = useCallback(
    (fileId: string) => {
      const nextViewed = toggleId(reviewState.viewedFileIds, fileId);
      const isViewed = nextViewed.includes(fileId);
      const nextCollapsed = isViewed
        ? uniqueIds([...reviewState.collapsedFileIds, fileId])
        : reviewState.collapsedFileIds;

      pendingCollapsedScrollTargetRef.current =
        isViewed && !reviewState.collapsedFileIds.includes(fileId)
          ? getAdjacentFileId(files, fileId)
          : null;

      applyStatePatch(
        {
          viewedFileIds: nextViewed,
          collapsedFileIds: nextCollapsed,
        },
        {
          onError: () => {
            pendingCollapsedScrollTargetRef.current = null;
          },
        },
      );
    },
    [
      applyStatePatch,
      files,
      reviewState.collapsedFileIds,
      reviewState.viewedFileIds,
    ],
  );

  const expandAll = useCallback(() => {
    applyStatePatch({ collapsedFileIds: [] });
  }, [applyStatePatch]);

  const collapseAll = useCallback(() => {
    applyStatePatch({ collapsedFileIds: files.map((file) => file.id) });
  }, [applyStatePatch, files]);

  const collapseViewed = useCallback(() => {
    applyStatePatch({
      collapsedFileIds: uniqueIds([
        ...reviewState.collapsedFileIds,
        ...reviewState.viewedFileIds,
      ]),
    });
  }, [
    applyStatePatch,
    reviewState.collapsedFileIds,
    reviewState.viewedFileIds,
  ]);

  useLayoutEffect(() => {
    const targetFileId = pendingCollapsedScrollTargetRef.current;
    if (!targetFileId) {
      return;
    }

    pendingCollapsedScrollTargetRef.current = null;
    scrollToFile(targetFileId, "auto");
  }, [reviewState.collapsedFileIds, scrollToFile]);

  const activateLine = useCallback(
    (fileId: string, lineNumber: number, side: CommentDraft["side"]) => {
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

    void syncState(
      createThread({
        fileId: draft.fileId,
        filePath: resolveDraftFilePath(draft, files),
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

  const addReply = useCallback(
    (threadId: string, text: string) => {
      void syncState(replyToThread({ id: threadId, text }));
    },
    [syncState],
  );

  const requestAgent = useCallback(
    (threadId: string) => {
      setStatus("");
      setThreadLoading(threadId, true);
      void syncState(requestThreadMessage(threadId), {
        onError: () => {
          setThreadLoading(threadId, false);
        },
      });
    },
    [setThreadLoading, syncState],
  );

  const requestBrief = useCallback(() => {
    setStatus("");
    setBriefLoading(true);
    void syncState(generateBrief(), {
      onError: () => {
        setBriefLoading(false);
      },
    });
  }, [setBriefLoading, syncState]);

  const toggleResolved = useCallback(
    (threadId: string, resolved: boolean) => {
      void syncState(resolveThread({ id: threadId, resolved }));
    },
    [syncState],
  );

  const toggleThreadCollapsed = useCallback(
    (threadId: string, collapsed: boolean) => {
      void syncState(collapseThread({ id: threadId, collapsed }));
    },
    [syncState],
  );

  const threadsByFileId = useMemo(
    () => buildThreadsByFileId(reviewState.threads),
    [reviewState.threads],
  );

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

  const handleSubmit = useCallback(async () => {
    setFinished(true);
    setStatus("Returning review…");
    try {
      await returnReview();
      setStatus("Review returned. You can close this tab.");
    } catch (error) {
      setFinished(false);
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const handleCancel = useCallback(async () => {
    setFinished(true);
    setStatus("Cancelling…");
    try {
      await cancelReview();
      setStatus("Cancelled. You can close this tab.");
    } catch (error) {
      setFinished(false);
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const handleBriefClick = useCallback(() => {
    if (hasBrief) {
      setBriefOpen(true);
      return;
    }
    requestBrief();
  }, [hasBrief, requestBrief]);

  return (
    <>
      <div className={`app${reviewState.sidebarOpen ? " sidebar-open" : ""}`}>
        <TopBar
          fileCount={files.length}
          viewedCount={reviewState.viewedFileIds.length}
          additions={totals.additions}
          deletions={totals.deletions}
          commentCount={unresolvedThreadCount}
          diffCommand={bootstrap?.context.diffCommand}
          diffStyle={reviewState.diffStyle}
          overflowMode={reviewState.overflowMode}
          sidebarOpen={reviewState.sidebarOpen}
          finished={finished}
          status={status}
          briefLoading={reviewState.brief.loading}
          hasBrief={hasBrief}
          onBriefClick={handleBriefClick}
          onToggleSidebar={() => {
            applyStatePatch({ sidebarOpen: !reviewState.sidebarOpen });
          }}
          onExpandAll={expandAll}
          onCollapseViewed={collapseViewed}
          onCollapseAll={collapseAll}
          onDiffStyleChange={(diffStyle) => {
            applyStatePatch({ diffStyle });
          }}
          onOverflowModeChange={(overflowMode) => {
            applyStatePatch({ overflowMode });
          }}
          onSubmit={handleSubmit}
          onCancel={handleCancel}
        />
        <Sidebar
          open={reviewState.sidebarOpen}
          files={files}
          viewed={viewed}
          onJumpToFile={scrollToFile}
        />
        <main className="content">
          {files.length === 0 && (
            <div className="empty">{status || "loading…"}</div>
          )}
          {files.map((file) => {
            const fileThreads =
              threadsByFileId.get(file.id) ?? emptyAnnotations;
            const annotations = withDraftAnnotation(
              fileThreads,
              file.id,
              draft,
              draftAnnotation,
            );

            return (
              <FileSection
                key={file.id}
                file={file}
                diffStyle={reviewState.diffStyle}
                overflowMode={reviewState.overflowMode}
                collapsed={collapsed[file.id] ?? false}
                viewed={viewed[file.id] ?? false}
                annotations={annotations}
                onToggleCollapsed={toggleCollapsed}
                onToggleViewed={toggleViewed}
                onLineActivate={activateLine}
                onDraftChange={updateDraft}
                onSaveDraft={saveDraft}
                onCancelDraft={cancelDraft}
                onAddReply={addReply}
                onRequestAgent={requestAgent}
                onToggleResolved={toggleResolved}
                onToggleThreadCollapsed={toggleThreadCollapsed}
              />
            );
          })}
        </main>
      </div>
      <BriefDialog
        open={briefOpen}
        content={reviewState.brief.content}
        loading={reviewState.brief.loading}
        onClose={() => setBriefOpen(false)}
      />
    </>
  );
}
