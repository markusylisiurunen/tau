import { ChevronsDownUp, ChevronsUpDown, Sparkles } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { CommentThread } from "../comments.js";
import { Checkbox } from "./checkbox.js";
import { MarkdownContent } from "./markdown_content.js";
import "./thread_card.css";

type ThreadCardProps = {
  thread: CommentThread;
  onAddReply: (text: string, requestAgent: boolean) => void;
  onRequestAgent: () => void;
  onToggleResolved: (resolved: boolean) => void;
  onToggleCollapsed: (collapsed: boolean) => void;
};

export const ThreadCard = memo(function ThreadCard({
  thread,
  onAddReply,
  onRequestAgent,
  onToggleResolved,
  onToggleCollapsed,
}: ThreadCardProps) {
  const [isReplying, setIsReplying] = useState(false);
  const [hasReplyText, setHasReplyText] = useState(false);
  const [requestAgentReply, setRequestAgentReply] = useState(false);
  const replyInputRef = useRef<HTMLTextAreaElement>(null);
  const lastMessage = thread.messages[thread.messages.length - 1];
  const canAsk =
    lastMessage?.role === "user" && !thread.loading && !thread.resolved;
  const count = thread.messages.length;
  const summary = `${thread.resolved ? "Resolved thread" : "Thread"} with ${count} comment${count === 1 ? "" : "s"}`;
  const resolveLabel = thread.resolved ? "reopen" : "resolve";

  useEffect(() => {
    if (!isReplying) {
      return;
    }
    replyInputRef.current?.focus();
  }, [isReplying]);

  const handleAddReply = useCallback(() => {
    const text = replyInputRef.current?.value.trim() ?? "";
    if (!text) {
      return;
    }
    if (replyInputRef.current) {
      replyInputRef.current.value = "";
    }
    setHasReplyText(false);
    setIsReplying(false);
    onAddReply(text, requestAgentReply);
    setRequestAgentReply(false);
  }, [onAddReply, requestAgentReply]);

  const handleReplyKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        handleAddReply();
      }
    },
    [handleAddReply],
  );

  const handleToggleResolved = useCallback(() => {
    onToggleResolved(!thread.resolved);
  }, [onToggleResolved, thread.resolved]);

  const handleCancelReply = useCallback(() => {
    if (replyInputRef.current) {
      replyInputRef.current.value = "";
    }
    setHasReplyText(false);
    setRequestAgentReply(false);
    setIsReplying(false);
  }, []);

  if (thread.collapsed) {
    return (
      <div
        className={`thread-card collapsed${thread.resolved ? " resolved" : ""}`}
      >
        <div className="thread-collapsed-row">
          <button
            type="button"
            className="thread-toggle"
            onClick={() => onToggleCollapsed(false)}
            aria-label="Expand thread"
            aria-expanded={false}
          >
            <ChevronsUpDown size={14} />
            <span className="thread-summary">{summary}</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`thread-card${thread.resolved ? " resolved" : ""}`}>
      <div className="thread-header-row">
        <button
          type="button"
          className="thread-toggle"
          onClick={() => onToggleCollapsed(true)}
          aria-label="Collapse thread"
          aria-expanded
        >
          <ChevronsDownUp size={14} />
          <span className="thread-summary">{summary}</span>
        </button>
      </div>
      <div className="thread-messages">
        {thread.messages.map((message, index) => (
          <div
            key={`${message.role}:${index}:${message.text}`}
            className={`thread-msg thread-msg-${message.role}`}
          >
            <span className="thread-msg-role">
              {message.role === "user" ? "you" : "agent"}
            </span>
            <MarkdownContent
              content={message.text}
              className="thread-msg-text"
              variant="thread"
            />
          </div>
        ))}
        {thread.loading && (
          <div className="thread-msg thread-msg-assistant">
            <span className="thread-msg-role">agent</span>
            <span className="thread-msg-thinking">thinking…</span>
          </div>
        )}
      </div>
      <div className="thread-footer">
        {isReplying ? (
          <>
            <textarea
              ref={replyInputRef}
              className="text-input-area thread-reply-input"
              onChange={(event) => {
                const nextHasReplyText = event.target.value.trim().length > 0;
                setHasReplyText((prev) =>
                  prev === nextHasReplyText ? prev : nextHasReplyText,
                );
              }}
              onKeyDown={handleReplyKeyDown}
              placeholder="Reply…"
              rows={3}
            />
            <div className="thread-actions">
              <Checkbox
                checked={requestAgentReply}
                label="ask agent"
                onChange={setRequestAgentReply}
              />
              <button
                type="button"
                className="btn ghost"
                onClick={handleCancelReply}
              >
                cancel
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={!hasReplyText}
                onClick={handleAddReply}
              >
                comment
              </button>
            </div>
          </>
        ) : (
          <div className="thread-actions">
            <button
              type="button"
              className="btn ghost"
              onClick={handleToggleResolved}
            >
              {resolveLabel}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setIsReplying(true)}
            >
              reply
            </button>
            {canAsk && (
              <button type="button" className="btn" onClick={onRequestAgent}>
                <Sparkles size={14} />
                ask agent
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
