import {
  Eye,
  EyeOff,
  History,
  MessageSquare,
  MessageSquarePlus,
  Plus,
} from "lucide-react";
import { Button } from "../../ui/button.js";
import type { CommentThread } from "../diff/comments.js";
import type { ReviewThreads } from "../threads/use_review_threads.js";
import { GuideConversation } from "./guide_conversation.js";
import "./guide_conversation.css";

type GuideConversationsProps = {
  conversations: ReviewThreads["guideConversations"];
};

export function GuideConversations({ conversations }: GuideConversationsProps) {
  const { items, selected, view } = conversations;

  return (
    <aside
      className="guide-conversation-panel"
      aria-label="Guide conversations"
    >
      <header className="guide-conversation-header">
        <Button
          variant="ghost"
          iconOnly
          active={view === "history"}
          aria-label="Conversation history"
          aria-pressed={view === "history"}
          title="Conversation history"
          onClick={conversations.showHistory}
        >
          <History size={16} />
        </Button>
        <div className="guide-conversation-header-actions">
          {selected && (
            <Button
              variant="ghost"
              iconOnly
              aria-label={
                selected.resolved
                  ? "Include conversation in review"
                  : "Exclude conversation from review"
              }
              title={
                selected.resolved ? "Include in review" : "Exclude from review"
              }
              onClick={() =>
                selected.resolved
                  ? conversations.include(selected.id)
                  : conversations.exclude(selected.id)
              }
            >
              {selected.resolved ? <Eye size={16} /> : <EyeOff size={16} />}
            </Button>
          )}
          <Button
            variant="ghost"
            iconOnly
            active={view === "new" && conversations.draftKind === "comment"}
            aria-label="Add global comment"
            aria-pressed={
              view === "new" && conversations.draftKind === "comment"
            }
            title="Add global comment"
            onClick={conversations.openComment}
          >
            <MessageSquarePlus size={16} />
          </Button>
          <Button
            variant="ghost"
            iconOnly
            active={
              view === "new" && conversations.draftKind === "conversation"
            }
            aria-label="New agent conversation"
            aria-pressed={
              view === "new" && conversations.draftKind === "conversation"
            }
            title="New agent conversation"
            onClick={conversations.openConversation}
          >
            <Plus size={16} />
          </Button>
        </div>
      </header>
      {view === "history" ? (
        <div className="guide-conversation-history">
          {items.length === 0 ? (
            <p className="guide-conversation-history-empty">
              No conversations yet
            </p>
          ) : (
            items.map((thread) => {
              const title = getConversationTitle(thread);
              return (
                <Button
                  key={thread.id}
                  variant="unstyled"
                  className={`guide-conversation-item${thread.resolved ? " excluded" : ""}`}
                  onClick={() => conversations.open(thread.id)}
                  title={title}
                >
                  <MessageSquare size={14} aria-hidden="true" />
                  <span>{title}</span>
                  {thread.resolved ? (
                    <span className="guide-conversation-excluded">
                      Excluded
                    </span>
                  ) : (
                    <span
                      className={`guide-conversation-status${thread.loading ? " active" : ""}`}
                      aria-label={
                        thread.loading ? "Agent responding" : undefined
                      }
                      aria-hidden={thread.loading ? undefined : true}
                    />
                  )}
                </Button>
              );
            })
          )}
        </div>
      ) : (
        <GuideConversation
          key={selected?.id ?? "new"}
          thread={selected}
          body={conversations.body}
          draftKind={conversations.draftKind}
          submitting={conversations.submitting}
          onBodyChange={conversations.setBody}
          onSubmit={conversations.submit}
        />
      )}
    </aside>
  );
}

function getConversationTitle(thread: CommentThread): string {
  const firstUserMessage = thread.messages.find(
    (message) => message.role === "user",
  );
  const normalized = firstUserMessage?.text.replace(/\s+/g, " ").trim() ?? "";
  if (!normalized) {
    return "New conversation";
  }

  return normalized.length <= 96
    ? normalized
    : `${normalized.slice(0, 93).trimEnd()}…`;
}
