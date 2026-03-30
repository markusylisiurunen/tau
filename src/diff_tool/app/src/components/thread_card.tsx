import { Loader, MessageSquarePlus, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import Markdown from "react-markdown";
import type { CommentThread } from "../comments.js";
import "./button.css";
import "./thread_card.css";

type ThreadCardProps = {
  thread: CommentThread;
  onDelete: () => void;
  onAddReply: (text: string) => void;
  onRequestAgent: () => void;
};

export function ThreadCard({
  thread,
  onDelete,
  onAddReply,
  onRequestAgent,
}: ThreadCardProps) {
  const [replyBody, setReplyBody] = useState("");
  const lastMsg = thread.messages[thread.messages.length - 1];
  const lastIsUser = lastMsg?.role === "user";
  const hasAgentResponse = thread.messages.some((m) => m.role === "assistant");
  const canAsk = lastIsUser && !thread.loading;
  const showReplyInput =
    hasAgentResponse && lastMsg?.role === "assistant" && !thread.loading;

  const handleAddReply = useCallback(() => {
    const text = replyBody.trim();
    if (!text) return;
    setReplyBody("");
    onAddReply(text);
  }, [replyBody, onAddReply]);

  const handleReplyKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleAddReply();
      }
    },
    [handleAddReply],
  );

  return (
    <div className="thread-card">
      <button
        type="button"
        className="icon-btn ghost thread-delete"
        aria-label="Delete thread"
        onClick={onDelete}
      >
        <Trash2 size={11} />
      </button>
      <div className="thread-messages">
        {thread.messages.map((msg, i) => (
          <div key={i} className={`thread-msg thread-msg-${msg.role}`}>
            <span className="thread-msg-role">
              {msg.role === "user" ? "you" : "agent"}
            </span>
            <div className="thread-msg-text">
              <Markdown>{msg.text}</Markdown>
            </div>
          </div>
        ))}
        {thread.loading && (
          <div className="thread-msg thread-msg-assistant">
            <span className="thread-msg-role">agent</span>
            <span className="thread-msg-text thread-loading">
              <Loader size={11} className="spin" />
              thinking…
            </span>
          </div>
        )}
      </div>
      {showReplyInput && (
        <textarea
          className="thread-reply-input"
          value={replyBody}
          onChange={(e) => setReplyBody(e.target.value)}
          onKeyDown={handleReplyKeyDown}
          placeholder="Reply…"
          rows={1}
        />
      )}
      <div className="thread-actions">
        {showReplyInput && (
          <button
            type="button"
            className="btn ghost"
            disabled={!replyBody.trim()}
            onClick={handleAddReply}
          >
            <MessageSquarePlus size={12} />
            reply
          </button>
        )}
        {canAsk && (
          <button
            type="button"
            className="btn primary"
            onClick={onRequestAgent}
          >
            <Sparkles size={12} />
            ask agent
          </button>
        )}
      </div>
    </div>
  );
}
