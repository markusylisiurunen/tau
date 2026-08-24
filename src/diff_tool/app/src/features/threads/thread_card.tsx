import { ChevronsDownUp, ChevronsUpDown, Sparkles } from "lucide-react";
import { memo, useCallback, useState } from "react";
import { Button } from "../../ui/button.js";
import type { CommentThread } from "../diff/comments.js";
import { Checkbox } from "../../ui/checkbox.js";
import { TextComposer } from "../../ui/text_composer.js";
import { ThreadMessages } from "./thread_messages.js";
import "./thread_card.css";

type ThreadCardProps = {
  thread: CommentThread;
  onAddReply: (text: string, requestAgent: boolean) => void;
  onRequestAgent: () => void;
  onToggleResolved: (resolved: boolean) => void;
  onToggleCollapsed: (collapsed: boolean) => void;
  onDeleteMessage: (messageIndex: number) => void;
};

export const ThreadCard = memo(function ThreadCard({
  thread,
  onAddReply,
  onRequestAgent,
  onToggleResolved,
  onToggleCollapsed,
  onDeleteMessage,
}: ThreadCardProps) {
  const [isReplying, setIsReplying] = useState(false);
  const [requestAgentReply, setRequestAgentReply] = useState(false);
  const lastMessage = thread.messages[thread.messages.length - 1];
  const canAsk =
    lastMessage?.role === "user" && !thread.loading && !thread.resolved;
  const count = thread.messages.length;
  const summary = `${thread.resolved ? "Resolved thread" : "Thread"} with ${count} comment${count === 1 ? "" : "s"}`;
  const resolveLabel = thread.resolved ? "Reopen" : "Resolve";

  const handleAddReply = useCallback(
    (text: string) => {
      setIsReplying(false);
      onAddReply(text, requestAgentReply);
      setRequestAgentReply(false);
    },
    [onAddReply, requestAgentReply],
  );

  const handleToggleResolved = useCallback(() => {
    onToggleResolved(!thread.resolved);
  }, [onToggleResolved, thread.resolved]);

  const handleCancelReply = useCallback(() => {
    setRequestAgentReply(false);
    setIsReplying(false);
  }, []);

  if (thread.collapsed) {
    return (
      <div
        className={`thread-card collapsed${thread.resolved ? " resolved" : ""}`}
      >
        <div className="thread-collapsed-row">
          <Button
            variant="unstyled"
            onClick={() => onToggleCollapsed(false)}
            aria-label="Expand thread"
            aria-expanded={false}
          >
            <ChevronsUpDown size={14} />
            <span className="thread-summary">{summary}</span>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={`thread-card${thread.resolved ? " resolved" : ""}`}>
      <div className="thread-header-row">
        <Button
          variant="unstyled"
          onClick={() => onToggleCollapsed(true)}
          aria-label="Collapse thread"
          aria-expanded
        >
          <ChevronsDownUp size={14} />
          <span className="thread-summary">{summary}</span>
        </Button>
      </div>
      <ThreadMessages thread={thread} onDeleteMessage={onDeleteMessage} />
      <div className="thread-footer">
        {isReplying ? (
          <TextComposer
            inputClassName="thread-reply-input"
            actionsClassName="thread-actions"
            placeholder="Reply…"
            submitLabel="Comment"
            autoFocus
            onSubmit={handleAddReply}
            onCancel={handleCancelReply}
          >
            <Checkbox
              checked={requestAgentReply}
              label="Ask agent"
              onChange={setRequestAgentReply}
            />
          </TextComposer>
        ) : (
          <div className="thread-actions">
            <Button variant="ghost" onClick={handleToggleResolved}>
              {resolveLabel}
            </Button>
            <Button onClick={() => setIsReplying(true)}>Reply</Button>
            {canAsk && (
              <Button onClick={onRequestAgent}>
                <Sparkles size={14} />
                Ask agent
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
