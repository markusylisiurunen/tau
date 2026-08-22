import { useLayoutEffect, useRef } from "react";
import { Button } from "../../ui/button.js";
import type { CommentThread } from "../diff/comments.js";
import { Checkbox } from "../../ui/checkbox.js";
import { Dialog } from "../../ui/dialog.js";
import { TextComposer } from "../../ui/text_composer.js";
import { ThreadMessages } from "./thread_messages.js";
import "./detached_thread_dialog.css";

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
  onDeleteMessage: (messageIndex: number) => void;
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
  onDeleteMessage,
}: DetachedThreadDialogProps) {
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const title = thread ? "conversation" : "new conversation";
  const resolveLabel = thread?.resolved ? "reopen" : "resolve";
  const submitLabel = thread ? "comment" : "start thread";
  const messageCount = thread?.messages.length ?? 0;

  useLayoutEffect(() => {
    if (!open) {
      return;
    }

    const messagesElement = messagesRef.current;
    if (!messagesElement) {
      return;
    }

    messagesElement.scrollTop = messagesElement.scrollHeight;
  }, [messageCount, open, thread?.id, thread?.loading]);

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
          {thread && (
            <ThreadMessages
              thread={thread}
              deleteIconSize={14}
              onDeleteMessage={onDeleteMessage}
            />
          )}
        </div>
        <TextComposer
          className={`detached-thread-dialog-composer${messageCount === 0 ? " empty" : ""}`}
          inputClassName="detached-thread-dialog-input"
          actionsClassName="detached-thread-dialog-actions"
          placeholder={thread ? "Reply…" : "Start a conversation…"}
          submitLabel={submitLabel}
          value={body}
          rows={3}
          autoFocus
          onValueChange={onBodyChange}
          onSubmit={onSubmit}
          onEscape={onClose}
        >
          <Checkbox
            checked={skipAgentResponse}
            label="skip agent reply"
            onChange={onSkipAgentResponseChange}
          />
          {thread && (
            <Button
              variant="ghost"
              onClick={() => onToggleResolved(!thread.resolved)}
            >
              {resolveLabel}
            </Button>
          )}
        </TextComposer>
      </div>
    </Dialog>
  );
}
