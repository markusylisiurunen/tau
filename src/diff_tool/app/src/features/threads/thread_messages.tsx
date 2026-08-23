import { Trash } from "lucide-react";
import { Button } from "../../ui/button.js";
import type { CommentThread } from "../diff/comments.js";
import { MarkdownContent } from "../../ui/markdown_content.js";
import "./thread_messages.css";

type ThreadMessagesProps = {
  thread: CommentThread;
  onDeleteMessage: (messageIndex: number) => void;
};

export function ThreadMessages({
  thread,
  onDeleteMessage,
}: ThreadMessagesProps) {
  return (
    <div className="thread-message-list">
      {thread.messages.map((message, index) => (
        <div
          key={`${message.role}:${index}:${message.text}`}
          className={`thread-message thread-message-${message.role}`}
        >
          <div className="thread-message-header">
            <span className="thread-message-role">
              {message.role === "user" ? "you" : "agent"}
            </span>
            <Button
              variant="ghost"
              iconOnly
              onClick={() => onDeleteMessage(index)}
              aria-label={`Delete ${message.role === "user" ? "your" : "agent"} comment`}
              title="delete comment"
            >
              <Trash size={13} />
            </Button>
          </div>
          <MarkdownContent content={message.text} variant="thread" />
        </div>
      ))}
      {thread.loading && (
        <div className="thread-message thread-message-assistant">
          <span className="thread-message-role">agent</span>
          <span className="thread-message-thinking">thinking…</span>
        </div>
      )}
    </div>
  );
}
