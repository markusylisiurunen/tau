import { useLayoutEffect, useRef } from "react";
import type { CommentThread } from "../diff/comments.js";

type GuideConversationComposerProps = {
  thread: CommentThread | null;
  body: string;
  draftKind: "comment" | "conversation";
  disabled: boolean;
  onBodyChange: (body: string) => void;
  onSubmit: () => void;
};

const maxVisibleRows = 5;

export function GuideConversationComposer({
  thread,
  body,
  draftKind,
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

  const inputLabel =
    !thread && draftKind === "comment"
      ? "Write a global review comment"
      : "Ask anything";

  return (
    <div className="guide-conversation-composer">
      <textarea
        ref={inputRef}
        className="guide-conversation-input"
        value={body}
        rows={1}
        autoFocus
        disabled={disabled}
        placeholder={`${inputLabel}…`}
        aria-label={inputLabel}
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
