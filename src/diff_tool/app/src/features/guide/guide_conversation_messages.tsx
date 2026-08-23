import { MarkdownContent } from "../../ui/markdown_content.js";
import type { CommentThread } from "../diff/comments.js";
import "./guide_conversation_messages.css";

type GuideConversationMessagesProps = {
  thread: CommentThread;
};

export function GuideConversationMessages({
  thread,
}: GuideConversationMessagesProps) {
  return (
    <div className="guide-conversation-message-list">
      {thread.messages.map((message, index) => (
        <article
          key={`${message.role}:${index}:${message.text}`}
          className={`guide-conversation-message ${message.role}`}
        >
          {message.role === "user" ? (
            <div className="guide-conversation-user-text">{message.text}</div>
          ) : (
            <MarkdownContent
              content={message.text}
              className="guide-conversation-message-content"
            />
          )}
        </article>
      ))}
      {thread.loading && (
        <div className="guide-conversation-message assistant loading">
          <span className="guide-conversation-thinking">Thinking…</span>
        </div>
      )}
    </div>
  );
}
