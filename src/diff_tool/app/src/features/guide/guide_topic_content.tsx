import type {
  DiffToolGuideComment,
  DiffToolGuideCommentTarget,
  DiffToolGuideOperation,
  DiffToolGuideTopic,
} from "../../types.js";
import { MarkdownContent } from "../../ui/markdown_content.js";
import { GuideFeedbackCard } from "./guide_feedback_card.js";

type GuideTopicContentProps = {
  topic: DiffToolGuideTopic;
  comments: DiffToolGuideComment[];
  loading: boolean;
  onOperate: (operation: DiffToolGuideOperation) => void;
  onComment: (target: DiffToolGuideCommentTarget, body: string) => void;
};

export function GuideTopicContent({
  topic,
  comments,
  loading,
  onOperate,
  onComment,
}: GuideTopicContentProps) {
  return (
    <article className="guide-topic-content">
      <header className="guide-topic-heading">
        <h3>{topic.heading}</h3>
      </header>
      <MarkdownContent content={topic.body} variant="guide" />
      <GuideFeedbackCard
        comments={comments}
        target={{ kind: "topic", topicId: topic.id }}
        loading={loading}
        requestChanges={{
          placeholder: "Describe the changes you want…",
          submitLabel: "Request changes",
          onSubmit: (request) => {
            onOperate({
              kind: "topic.revise",
              topicId: topic.id,
              request,
            });
          },
        }}
        onComment={onComment}
      />
    </article>
  );
}
