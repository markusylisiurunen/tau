import { useLayoutEffect, useRef } from "react";
import type { CommentThread } from "../diff/comments.js";
import { GuideConversationComposer } from "./guide_conversation_composer.js";
import { GuideConversationMessages } from "./guide_conversation_messages.js";
import "./guide_conversation.css";

type GuideConversationProps = {
  thread: CommentThread | null;
  body: string;
  draftKind: "comment" | "conversation";
  submitting: boolean;
  onBodyChange: (body: string) => void;
  onSubmit: () => void;
};

export function GuideConversation({
  thread,
  body,
  draftKind,
  submitting,
  onBodyChange,
  onSubmit,
}: GuideConversationProps) {
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const messageCount = thread?.messages.length ?? 0;

  useLayoutEffect(() => {
    const messagesElement = messagesRef.current;
    if (!messagesElement) {
      return;
    }

    messagesElement.scrollTop = messagesElement.scrollHeight;
  }, [messageCount, thread?.id, thread?.loading]);

  return (
    <>
      <div
        ref={messagesRef}
        className="guide-conversation-messages"
        aria-live="polite"
      >
        {thread ? (
          <GuideConversationMessages thread={thread} />
        ) : (
          <div className="guide-conversation-empty">
            {draftKind === "comment" ? (
              <>
                <h2>Add a global review comment</h2>
                <p>
                  Leave feedback that does not belong to a specific diff line or
                  guide block.
                </p>
              </>
            ) : (
              <>
                <h2>What would you like to know?</h2>
                <p>
                  Ask about the intent, tradeoffs, or any part of the change you
                  want to understand better.
                </p>
              </>
            )}
          </div>
        )}
      </div>
      <GuideConversationComposer
        thread={thread}
        body={body}
        draftKind={draftKind}
        disabled={submitting || Boolean(thread?.loading)}
        onBodyChange={onBodyChange}
        onSubmit={onSubmit}
      />
    </>
  );
}
