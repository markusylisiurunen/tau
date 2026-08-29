import { lazy, Suspense } from "react";
import "./App.css";
import { DiffWorkspace } from "./features/diff/diff_workspace.js";
import { useDiffFileState } from "./features/diff/use_diff_file_state.js";
import { useDiffRendererReady } from "./features/diff/use_diff_renderer_ready.js";
import { Guide } from "./features/guide/guide.js";
import { GuideConversations } from "./features/guide/guide_conversations.js";
import { useGuide } from "./features/guide/use_guide.js";
import { ReviewSubmissionDialog } from "./features/review/review_submission_dialog.js";
import { TopBar } from "./features/review/top_bar.js";
import { useReviewNavigation } from "./features/review/use_review_navigation.js";
import { useReviewSession } from "./features/review/use_review_session.js";
import { useReviewSubmission } from "./features/review/use_review_submission.js";
import { useReviewThreads } from "./features/threads/use_review_threads.js";
import { hasDiffToolReviewComments } from "./types.js";

const LocalAgentation = import.meta.env.DEV
  ? lazy(async () => {
      const { Agentation } = await import("agentation");
      return { default: Agentation };
    })
  : null;

export function App() {
  const session = useReviewSession();
  const navigation = useReviewNavigation();
  const fileState = useDiffFileState({
    files: session.files,
    reviewState: session.reviewState,
    applyStatePatch: session.applyStatePatch,
    scrollToFile: navigation.scrollToFile,
  });
  const threads = useReviewThreads({
    files: session.files,
    reviewState: session.reviewState,
    applyReviewState: session.applyReviewState,
    syncReviewState: session.syncReviewState,
    setThreadLoading: session.setThreadLoading,
  });
  const guide = useGuide({
    bootstrap: session.bootstrap,
    reviewState: session.reviewState,
    setGuideLoading: session.setGuideLoading,
    syncReviewState: session.syncReviewState,
  });
  const submission = useReviewSubmission({
    applyReviewState: session.applyReviewState,
  });
  const diffRendererReady = useDiffRendererReady(
    session.files,
    session.reviewState.codeTheme,
  );

  return (
    <>
      <div className={`app ${navigation.mode}-mode`}>
        <TopBar
          mode={navigation.mode}
          fileCount={session.files.length}
          viewedCount={session.reviewState.viewedFileIds.length}
          additions={fileState.totals.additions}
          deletions={fileState.totals.deletions}
          commentCount={fileState.unresolvedThreadCount}
          diffStyle={session.reviewState.diffStyle}
          overflowMode={session.reviewState.overflowMode}
          finished={submission.finished}
          hasReviewComments={hasDiffToolReviewComments(session.reviewState)}
          hasUnresolvedFileThreads={
            fileState.filesWithUnresolvedThreads.length > 0
          }
          onModeChange={navigation.changeMode}
          onExpandAll={fileState.expandAll}
          onExpandUnresolved={fileState.expandUnresolved}
          onCollapseViewed={fileState.collapseViewed}
          onCollapseAll={fileState.collapseAll}
          onDiffStyleChange={(diffStyle) => {
            session.applyStatePatch({ diffStyle });
          }}
          onOverflowModeChange={(overflowMode) => {
            session.applyStatePatch({ overflowMode });
          }}
          onSubmit={submission.openPreview}
          onCancel={submission.cancel}
        />
        {navigation.mode === "guide" ? (
          <>
            <main ref={navigation.contentRef} className="content guide-content">
              <Guide
                guide={session.reviewState.guide}
                pendingTopics={guide.pendingTopics}
                pendingQuestions={guide.pendingQuestions}
                onGenerate={guide.requestGuide}
                onOperate={guide.runGuideOperation}
                onComment={guide.saveComment}
              />
            </main>
            <GuideConversations conversations={threads.guideConversations} />
          </>
        ) : (
          <DiffWorkspace
            contentRef={navigation.contentRef}
            files={session.files}
            emptyContent={session.emptyContent}
            reviewState={session.reviewState}
            renderReady={diffRendererReady}
            fileState={fileState}
            threads={threads}
            onJumpToFile={navigation.scrollToFile}
          />
        )}
      </div>
      <ReviewSubmissionDialog {...submission} />
      {LocalAgentation ? (
        <Suspense fallback={null}>
          <LocalAgentation />
        </Suspense>
      ) : null}
    </>
  );
}
