import {
  lazy,
  Suspense,
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
  deleteThreadMessage,
  fetchBootstrap,
  fetchDiff,
  generateBrief,
  replyToThread,
  requestThreadMessage,
  resolveThread,
  returnReview,
  updateReviewState,
} from "./api.js";
import {
  type CommentDraft,
  type CommentThread,
  type LineAnnotation,
} from "./comments.js";
import {
  buildThreadsByFileId,
  countThreadsByFileId,
  emptyReviewState,
  isDetachedThread,
  isLineThread,
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
import { DetachedThreadDialog } from "./components/detached_thread_dialog.js";
import { FileSection } from "./components/file_section.js";
import { Sidebar } from "./components/sidebar.js";
import { TopBar } from "./components/top_bar.js";
import { parseDiff } from "./parse_diff.js";
import { useDiffRendererReady } from "./use_diff_renderer_ready.js";
import type {
  BootstrapPayload,
  DiffReviewGetDiffResult,
  DiffToolReviewState,
  ReviewStatePatch,
} from "./types.js";

const emptyAnnotations: LineAnnotation[] = [];

type DetachedThreadDialogState =
  { mode: "new" } | { mode: "thread"; threadId: string };

const LocalAgentation = import.meta.env.DEV
  ? lazy(async () => {
      const { Agentation } = await import("agentation");
      return { default: Agentation };
    })
  : null;

export function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [diff, setDiff] = useState<DiffReviewGetDiffResult | null>(null);
  const [reviewState, setReviewState] =
    useState<DiffToolReviewState>(emptyReviewState);
  const [draft, setDraft] = useState<CommentDraft | null>(null);
  const [detachedDraftBody, setDetachedDraftBody] = useState("");
  const [detachedSkipAgentResponse, setDetachedSkipAgentResponse] =
    useState(false);
  const [detachedThreadDialog, setDetachedThreadDialog] =
    useState<DetachedThreadDialogState | null>(null);
  const [finished, setFinished] = useState(false);
  const [status, setStatus] = useState("");
  const [briefOpen, setBriefOpen] = useState(false);
  const [submitPopoverOpen, setSubmitPopoverOpen] = useState(false);
  const [submitPopoverAnchor, setSubmitPopoverAnchor] =
    useState<DOMRect | null>(null);
  const [submitMessage, setSubmitMessage] = useState("");
  const submitPopoverRef = useRef<HTMLDivElement | null>(null);
  const pendingCollapsedScrollTargetRef = useRef<string | null>(null);
  const detachedThreadDialogVersionRef = useRef(0);

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

  const requestThreadAgentReply = useCallback(
    async (threadId: string) => {
      setThreadLoading(threadId, true);
      try {
        const agentResult = await requestThreadMessage(threadId);
        applyReviewState(agentResult.state);
      } catch (error) {
        setThreadLoading(threadId, false);
        setStatus(error instanceof Error ? error.message : String(error));
      }
    },
    [applyReviewState, setThreadLoading],
  );

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
  const emptyContent = status || (diff ? "no changes to review" : "loading…");

  const diffRendererReady = useDiffRendererReady(files, reviewState.codeTheme);

  const collapsed = useMemo(
    () => toLookup(reviewState.collapsedFileIds),
    [reviewState.collapsedFileIds],
  );
  const viewed = useMemo(
    () => toLookup(reviewState.viewedFileIds),
    [reviewState.viewedFileIds],
  );
  const unresolvedThreads = useMemo(
    () => reviewState.threads.filter((thread) => !thread.resolved),
    [reviewState.threads],
  );
  const unresolvedThreadCount = unresolvedThreads.length;
  const sidebarThreads = useMemo(
    () => [...reviewState.threads].reverse(),
    [reviewState.threads],
  );
  const detachedThreads = useMemo(
    () => reviewState.threads.filter(isDetachedThread),
    [reviewState.threads],
  );
  const selectedDetachedThread = useMemo(() => {
    if (detachedThreadDialog?.mode !== "thread") {
      return null;
    }

    return (
      detachedThreads.find(
        (thread) => thread.id === detachedThreadDialog.threadId,
      ) ?? null
    );
  }, [detachedThreadDialog, detachedThreads]);
  const filesWithUnresolvedThreads = useMemo(
    () =>
      uniqueIds(
        unresolvedThreads
          .filter(isLineThread)
          .map((thread) => thread.anchor.fileId),
      ),
    [unresolvedThreads],
  );
  const unresolvedThreadCountsByFileId = useMemo(
    () => countThreadsByFileId(unresolvedThreads),
    [unresolvedThreads],
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
          ? fileId
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
    [applyStatePatch, reviewState.collapsedFileIds, reviewState.viewedFileIds],
  );

  const expandAll = useCallback(() => {
    applyStatePatch({ collapsedFileIds: [] });
  }, [applyStatePatch]);

  const collapseAll = useCallback(() => {
    applyStatePatch({ collapsedFileIds: files.map((file) => file.id) });
  }, [applyStatePatch, files]);

  const expandUnresolved = useCallback(() => {
    if (filesWithUnresolvedThreads.length === 0) {
      return;
    }

    const unresolvedFileIds = new Set(filesWithUnresolvedThreads);
    applyStatePatch({
      collapsedFileIds: reviewState.collapsedFileIds.filter(
        (fileId) => !unresolvedFileIds.has(fileId),
      ),
    });
  }, [
    applyStatePatch,
    filesWithUnresolvedThreads,
    reviewState.collapsedFileIds,
  ]);

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
        return { fileId, lineNumber, side };
      });
    },
    [],
  );

  const saveDraft = useCallback(
    (body: string, shouldRequestAgent: boolean) => {
      if (!draft) {
        return;
      }

      const trimmedBody = body.trim();
      if (!trimmedBody) {
        setDraft(null);
        return;
      }

      const anchor = {
        kind: "line" as const,
        fileId: draft.fileId,
        filePath: resolveDraftFilePath(draft, files),
        lineNumber: draft.lineNumber,
        side: draft.side,
      };

      const save = async () => {
        try {
          const createResult = await createThread({
            body: trimmedBody,
            anchor,
          });
          applyReviewState(createResult.state);
          setDraft(null);

          if (!shouldRequestAgent) {
            return;
          }

          await requestThreadAgentReply(createResult.threadId);
        } catch (error) {
          setStatus(error instanceof Error ? error.message : String(error));
        }
      };

      void save();
    },
    [applyReviewState, draft, files, requestThreadAgentReply],
  );

  const cancelDraft = useCallback(() => setDraft(null), []);

  const openDetachedThreadDraft = useCallback(() => {
    detachedThreadDialogVersionRef.current += 1;
    setDetachedDraftBody("");
    setDetachedSkipAgentResponse(false);
    setDetachedThreadDialog({ mode: "new" });
  }, []);

  const openDetachedThread = useCallback((threadId: string) => {
    detachedThreadDialogVersionRef.current += 1;
    setDetachedDraftBody("");
    setDetachedSkipAgentResponse(false);
    setDetachedThreadDialog({ mode: "thread", threadId });
  }, []);

  const closeDetachedThreadDialog = useCallback(() => {
    detachedThreadDialogVersionRef.current += 1;
    setDetachedDraftBody("");
    setDetachedSkipAgentResponse(false);
    setDetachedThreadDialog(null);
  }, []);

  useEffect(() => {
    if (detachedThreadDialog?.mode === "thread" && !selectedDetachedThread) {
      closeDetachedThreadDialog();
    }
  }, [closeDetachedThreadDialog, detachedThreadDialog, selectedDetachedThread]);

  const openThread = useCallback(
    (thread: CommentThread) => {
      if (thread.anchor.kind === "detached") {
        openDetachedThread(thread.id);
        return;
      }

      closeDetachedThreadDialog();
      const fileId = thread.anchor.fileId;
      if (reviewState.collapsedFileIds.includes(fileId)) {
        pendingCollapsedScrollTargetRef.current = fileId;
        applyStatePatch({
          collapsedFileIds: reviewState.collapsedFileIds.filter(
            (id) => id !== fileId,
          ),
        });
        return;
      }

      scrollToFile(fileId);
    },
    [
      applyStatePatch,
      closeDetachedThreadDialog,
      openDetachedThread,
      reviewState.collapsedFileIds,
      scrollToFile,
    ],
  );

  const updateDetachedDraft = useCallback((body: string) => {
    setDetachedDraftBody(body);
  }, []);

  const resetDetachedDraftIfCurrent = useCallback((dialogVersion: number) => {
    if (detachedThreadDialogVersionRef.current !== dialogVersion) {
      return false;
    }

    setDetachedDraftBody("");
    setDetachedSkipAgentResponse(false);
    return true;
  }, []);

  const submitDetachedDraft = useCallback(async () => {
    const body = detachedDraftBody.trim();
    if (!body) {
      return;
    }

    const shouldTriggerAgent = !detachedSkipAgentResponse;
    const dialogVersion = detachedThreadDialogVersionRef.current;
    setStatus("");

    try {
      if (detachedThreadDialog?.mode === "thread") {
        const replyResult = await replyToThread({
          id: detachedThreadDialog.threadId,
          text: body,
        });
        applyReviewState(replyResult.state);
        if (!resetDetachedDraftIfCurrent(dialogVersion)) {
          return;
        }

        if (!shouldTriggerAgent) {
          return;
        }

        await requestThreadAgentReply(detachedThreadDialog.threadId);
        return;
      }

      const createResult = await createThread({
        body,
        anchor: { kind: "detached" },
      });
      applyReviewState(createResult.state);

      if (!resetDetachedDraftIfCurrent(dialogVersion)) {
        return;
      }
      setDetachedThreadDialog({
        mode: "thread",
        threadId: createResult.threadId,
      });

      if (!shouldTriggerAgent) {
        return;
      }

      await requestThreadAgentReply(createResult.threadId);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }, [
    applyReviewState,
    detachedDraftBody,
    detachedSkipAgentResponse,
    detachedThreadDialog,
    requestThreadAgentReply,
    resetDetachedDraftIfCurrent,
  ]);

  const addReply = useCallback(
    (threadId: string, text: string, shouldRequestAgent: boolean) => {
      if (!shouldRequestAgent) {
        void syncState(replyToThread({ id: threadId, text }));
        return;
      }

      const reply = async () => {
        try {
          const replyResult = await replyToThread({ id: threadId, text });
          applyReviewState(replyResult.state);
          await requestThreadAgentReply(threadId);
        } catch (error) {
          setStatus(error instanceof Error ? error.message : String(error));
        }
      };

      void reply();
    },
    [applyReviewState, requestThreadAgentReply, syncState],
  );

  const requestAgent = useCallback(
    (threadId: string) => {
      setStatus("");
      void requestThreadAgentReply(threadId);
    },
    [requestThreadAgentReply],
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

  const removeThreadMessage = useCallback(
    (threadId: string, messageIndex: number) => {
      void syncState(deleteThreadMessage({ id: threadId, messageIndex }));
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

  const openSubmitPopover = useCallback((anchor: DOMRect) => {
    setSubmitPopoverAnchor(anchor);
    setSubmitPopoverOpen(true);
  }, []);

  const closeSubmitPopover = useCallback(() => {
    setSubmitPopoverOpen(false);
  }, []);

  const submitReview = useCallback(async (message: string) => {
    setFinished(true);
    setSubmitPopoverOpen(false);
    setStatus("Returning review…");
    try {
      await returnReview(message);
      setStatus("Review returned. You can close this tab.");
    } catch (error) {
      setFinished(false);
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const handleSubmit = useCallback(() => {
    void submitReview("");
  }, [submitReview]);

  const handleSubmitWithMessage = useCallback(() => {
    void submitReview(submitMessage);
  }, [submitMessage, submitReview]);

  useEffect(() => {
    if (!submitPopoverOpen) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        submitPopoverRef.current?.contains(target)
      ) {
        return;
      }
      setSubmitPopoverOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSubmitPopoverOpen(false);
      }
    };

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [submitPopoverOpen]);

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
          diffArgs={bootstrap?.context.diffArgs}
          diffCommand={bootstrap?.context.diffCommand}
          diffStyle={reviewState.diffStyle}
          overflowMode={reviewState.overflowMode}
          sidebarOpen={reviewState.sidebarOpen}
          finished={finished}
          status={status}
          briefLoading={reviewState.brief.loading}
          hasBrief={hasBrief}
          hasUnresolvedFileThreads={filesWithUnresolvedThreads.length > 0}
          onBriefClick={handleBriefClick}
          onToggleSidebar={() => {
            applyStatePatch({ sidebarOpen: !reviewState.sidebarOpen });
          }}
          onExpandAll={expandAll}
          onExpandUnresolved={expandUnresolved}
          onCollapseViewed={collapseViewed}
          onCollapseAll={collapseAll}
          onDiffStyleChange={(diffStyle) => {
            applyStatePatch({ diffStyle });
          }}
          onOverflowModeChange={(overflowMode) => {
            applyStatePatch({ overflowMode });
          }}
          onSubmit={handleSubmit}
          onOpenSubmitPopover={openSubmitPopover}
          onCancel={handleCancel}
        />
        <Sidebar
          open={reviewState.sidebarOpen}
          files={files}
          viewed={viewed}
          threads={sidebarThreads}
          selectedThreadId={
            detachedThreadDialog?.mode === "thread"
              ? detachedThreadDialog.threadId
              : null
          }
          onJumpToFile={scrollToFile}
          onCreateDetachedThread={openDetachedThreadDraft}
          onOpenThread={openThread}
        />
        <main className="content">
          {files.length === 0 && <div className="empty">{emptyContent}</div>}
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
                codeTheme={reviewState.codeTheme}
                collapsed={collapsed[file.id] ?? false}
                viewed={viewed[file.id] ?? false}
                annotations={annotations}
                unresolvedThreadCount={
                  unresolvedThreadCountsByFileId.get(file.id) ?? 0
                }
                renderReady={diffRendererReady}
                onToggleCollapsed={toggleCollapsed}
                onToggleViewed={toggleViewed}
                onLineActivate={activateLine}
                onSaveDraft={saveDraft}
                onCancelDraft={cancelDraft}
                onAddReply={addReply}
                onRequestAgent={requestAgent}
                onToggleResolved={toggleResolved}
                onToggleThreadCollapsed={toggleThreadCollapsed}
                onDeleteThreadMessage={removeThreadMessage}
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
      {submitPopoverOpen && submitPopoverAnchor ? (
        <div
          ref={submitPopoverRef}
          className="submit-popover"
          style={{
            top: submitPopoverAnchor.bottom + 6,
            right: window.innerWidth - submitPopoverAnchor.right,
          }}
        >
          <textarea
            className="text-input-area submit-popover-input"
            value={submitMessage}
            onChange={(event) => setSubmitMessage(event.target.value)}
            placeholder="Optional message…"
            rows={5}
          />
          <div className="submit-popover-actions">
            <button
              type="button"
              className="btn ghost"
              onClick={closeSubmitPopover}
            >
              cancel
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={finished}
              onClick={handleSubmitWithMessage}
            >
              submit
            </button>
          </div>
        </div>
      ) : null}
      <DetachedThreadDialog
        open={detachedThreadDialog !== null}
        thread={selectedDetachedThread}
        body={detachedDraftBody}
        skipAgentResponse={detachedSkipAgentResponse}
        onBodyChange={updateDetachedDraft}
        onSkipAgentResponseChange={setDetachedSkipAgentResponse}
        onSubmit={submitDetachedDraft}
        onClose={closeDetachedThreadDialog}
        onToggleResolved={(resolved) => {
          if (!selectedDetachedThread) {
            return;
          }
          toggleResolved(selectedDetachedThread.id, resolved);
        }}
        onDeleteMessage={(messageIndex) => {
          if (!selectedDetachedThread) {
            return;
          }
          removeThreadMessage(selectedDetachedThread.id, messageIndex);
        }}
      />
      {LocalAgentation ? (
        <Suspense fallback={null}>
          <LocalAgentation />
        </Suspense>
      ) : null}
    </>
  );
}
