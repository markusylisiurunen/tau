import type { RefObject } from "react";
import { withDraftAnnotation } from "../threads/thread_state.js";
import type { DiffToolReviewState } from "../../types.js";
import type { ReviewThreads } from "../threads/use_review_threads.js";
import type { LineAnnotation } from "./comments.js";
import { FileSection } from "./file_section.js";
import type { DiffFile } from "./parse_diff.js";
import { Sidebar } from "./sidebar.js";
import type { DiffFileState } from "./use_diff_file_state.js";

const emptyAnnotations: LineAnnotation[] = [];

type DiffWorkspaceProps = {
  contentRef: RefObject<HTMLElement | null>;
  files: DiffFile[];
  emptyContent: string;
  reviewState: DiffToolReviewState;
  renderReady: boolean;
  fileState: DiffFileState;
  threads: ReviewThreads;
  onJumpToFile: (fileId: string) => void;
};

export function DiffWorkspace({
  contentRef,
  files,
  emptyContent,
  reviewState,
  renderReady,
  fileState,
  threads,
  onJumpToFile,
}: DiffWorkspaceProps) {
  return (
    <>
      <Sidebar
        files={files}
        viewed={fileState.viewed}
        threads={fileState.sidebarThreads}
        selectedThreadId={threads.selectedDetachedThreadId}
        onJumpToFile={onJumpToFile}
        onCreateDetachedThread={threads.openDetachedThreadDraft}
        onOpenThread={threads.openThread}
      />
      <main ref={contentRef} className="content">
        {files.length === 0 && <div className="empty">{emptyContent}</div>}
        {files.map((file) => {
          const fileThreads =
            threads.threadsByFileId.get(file.id) ?? emptyAnnotations;
          const annotations = withDraftAnnotation(
            fileThreads,
            file.id,
            threads.draft,
            threads.draftAnnotation,
          );

          return (
            <FileSection
              key={file.id}
              file={file}
              diffStyle={reviewState.diffStyle}
              overflowMode={reviewState.overflowMode}
              codeTheme={reviewState.codeTheme}
              collapsed={fileState.collapsed[file.id] ?? false}
              viewed={fileState.viewed[file.id] ?? false}
              annotations={annotations}
              unresolvedThreadCount={
                fileState.unresolvedThreadCountsByFileId.get(file.id) ?? 0
              }
              renderReady={renderReady}
              onToggleCollapsed={fileState.toggleCollapsed}
              onToggleViewed={fileState.toggleViewed}
              onLineActivate={threads.activateLine}
              onSaveDraft={threads.saveDraft}
              onCancelDraft={threads.cancelDraft}
              onAddReply={threads.addReply}
              onRequestAgent={threads.requestAgent}
              onToggleResolved={threads.toggleResolved}
              onToggleThreadCollapsed={threads.toggleThreadCollapsed}
              onDeleteThreadMessage={threads.removeThreadMessage}
            />
          );
        })}
      </main>
    </>
  );
}
