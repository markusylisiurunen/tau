import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { CommentThread } from "../comments.js";
import { Checkbox } from "./checkbox.js";
import "./detached_thread_dialog.css";
import { Dialog } from "./dialog.js";
import { MarkdownContent } from "./markdown_content.js";

type DetachedThreadDialogProps = {
  open: boolean;
  thread: CommentThread | null;
  body: string;
  skipAgentResponse: boolean;
  onBodyChange: (body: string) => void;
  onSkipAgentResponseChange: (checked: boolean) => void;
  onSubmit: () => void;
  onClose: () => void;
  onToggleResolved: (resolved: boolean) => void;
};

export function DetachedThreadDialog({
  open,
  thread,
  body,
  skipAgentResponse,
  onBodyChange,
  onSkipAgentResponseChange,
  onSubmit,
  onClose,
  onToggleResolved,
}: DetachedThreadDialogProps) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const title = thread ? "conversation" : "new conversation";
  const resolveLabel = thread?.resolved ? "reopen" : "resolve";
  const submitLabel = thread ? "comment" : "start thread";
  const canSubmit = body.trim().length > 0;
  const messages = useMemo(() => thread?.messages ?? [], [thread]);

  useEffect(() => {
    if (!open) {
      return;
    }

    inputRef.current?.focus();
  }, [open, thread?.id]);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }

    const messagesElement = messagesRef.current;
    if (!messagesElement) {
      return;
    }

    messagesElement.scrollTop = messagesElement.scrollHeight;
  }, [messages.length, open, thread?.id, thread?.loading]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (canSubmit) {
        onSubmit();
      }
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <Dialog
      open={open}
      title={title}
      ariaLabel={title}
      closeLabel="close conversation"
      bodyClassName="detached-thread-dialog-body-wrap"
      onClose={onClose}
    >
      <div className="detached-thread-dialog-layout">
        <div ref={messagesRef} className="detached-thread-dialog-messages">
          {messages.map((message, index) => (
            <div
              key={`${message.role}:${index}:${message.text}`}
              className={`detached-thread-dialog-message detached-thread-dialog-message-${message.role}`}
            >
              <span className="detached-thread-dialog-role">
                {message.role === "user" ? "you" : "agent"}
              </span>
              <MarkdownContent
                content={message.text}
                className="detached-thread-dialog-text"
                variant="thread"
              />
            </div>
          ))}
          {thread?.loading && (
            <div className="detached-thread-dialog-message detached-thread-dialog-message-assistant">
              <span className="detached-thread-dialog-role">agent</span>
              <span className="detached-thread-dialog-thinking">thinking…</span>
            </div>
          )}
        </div>
        <div
          className="detached-thread-dialog-composer"
          style={{ borderTop: messages.length === 0 ? "none" : undefined }}
        >
          <textarea
            ref={inputRef}
            className="text-input-area detached-thread-dialog-input"
            value={body}
            onChange={(event) => onBodyChange(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={thread ? "Reply…" : "Start a conversation…"}
            rows={3}
          />
          <div className="detached-thread-dialog-actions">
            <Checkbox
              checked={skipAgentResponse}
              label="skip agent reply"
              onChange={onSkipAgentResponseChange}
            />
            {thread && (
              <button
                type="button"
                className="btn detached-thread-dialog-secondary"
                onClick={() => onToggleResolved(!thread.resolved)}
              >
                {resolveLabel}
              </button>
            )}
            <button
              type="button"
              className="btn primary"
              disabled={!canSubmit}
              onClick={onSubmit}
            >
              {submitLabel}
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
