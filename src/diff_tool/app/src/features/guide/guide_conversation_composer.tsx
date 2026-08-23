import { useLayoutEffect, useRef } from "react";
import type { CommentThread } from "../diff/comments.js";

type GuideConversationComposerProps = {
  thread: CommentThread | null;
  body: string;
  disabled: boolean;
  onBodyChange: (body: string) => void;
  onSubmit: () => void;
};

const maxVisibleRows = 5;

export function GuideConversationComposer({
  thread,
  body,
  disabled,
  onBodyChange,
  onSubmit,
}: GuideConversationComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) {
      return;
    }

    input.style.height = "auto";
    const style = getComputedStyle(input);
    const lineHeight = Number.parseFloat(style.lineHeight);
    const verticalChrome =
      Number.parseFloat(style.paddingTop) +
      Number.parseFloat(style.paddingBottom) +
      Number.parseFloat(style.borderTopWidth) +
      Number.parseFloat(style.borderBottomWidth);
    const maxHeight = lineHeight * maxVisibleRows + verticalChrome;
    const nextHeight = Math.min(input.scrollHeight, maxHeight);

    input.style.height = `${nextHeight}px`;
    input.style.overflowY = input.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [body]);

  if (thread?.resolved) {
    return (
      <div className="guide-conversation-excluded-footer">
        Excluded from review
      </div>
    );
  }

  return (
    <div className="guide-conversation-composer">
      <textarea
        ref={inputRef}
        className="guide-conversation-input"
        value={body}
        rows={1}
        autoFocus
        disabled={disabled}
        placeholder="Ask anything…"
        aria-label="Ask anything"
        onChange={(event) => onBodyChange(event.target.value)}
        onKeyDown={(event) => {
          if (
            event.key !== "Enter" ||
            event.shiftKey ||
            event.nativeEvent.isComposing
          ) {
            return;
          }

          event.preventDefault();
          if (body.trim()) {
            onSubmit();
          }
        }}
      />
    </div>
  );
}
