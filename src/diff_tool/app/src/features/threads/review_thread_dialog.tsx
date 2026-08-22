import { DetachedThreadDialog } from "./detached_thread_dialog.js";
import type { ReviewThreads } from "./use_review_threads.js";

type ReviewThreadDialogProps = {
  threads: ReviewThreads;
};

export function ReviewThreadDialog({ threads }: ReviewThreadDialogProps) {
  const thread = threads.selectedDetachedThread;

  return (
    <DetachedThreadDialog
      open={threads.detachedDialogOpen}
      thread={thread}
      body={threads.detachedDraftBody}
      skipAgentResponse={threads.detachedSkipAgentResponse}
      onBodyChange={threads.setDetachedDraftBody}
      onSkipAgentResponseChange={threads.setDetachedSkipAgentResponse}
      onSubmit={threads.submitDetachedDraft}
      onClose={threads.closeDetachedThreadDialog}
      onToggleResolved={(resolved) => {
        if (thread) {
          threads.toggleResolved(thread.id, resolved);
        }
      }}
      onDeleteMessage={(messageIndex) => {
        if (thread) {
          threads.removeThreadMessage(thread.id, messageIndex);
        }
      }}
    />
  );
}
