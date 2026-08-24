import type {
  DiffToolGuide,
  DiffToolGuideCommentTarget,
  DiffToolGuideOperation,
} from "../../types.js";
import { Button } from "../../ui/button.js";
import { GuideOrientation } from "./guide_orientation.js";
import { GuideQuestions } from "./guide_questions.js";
import { GuideTopics } from "./guide_topics.js";
import type { PendingGuideQuestion, PendingGuideTopic } from "./use_guide.js";
import "./guide.css";

type GuideProps = {
  guide: DiffToolGuide;
  pendingTopics: PendingGuideTopic[];
  pendingQuestions: PendingGuideQuestion[];
  onGenerate: () => void;
  onOperate: (operation: DiffToolGuideOperation) => void;
  onComment: (target: DiffToolGuideCommentTarget, body: string) => void;
};

export function Guide({
  guide,
  pendingTopics,
  pendingQuestions,
  onGenerate,
  onOperate,
  onComment,
}: GuideProps) {
  if (!guide.orientation.trim()) {
    return (
      <section
        className="guide-empty"
        aria-labelledby="guide-empty-title"
        aria-busy={guide.loading}
      >
        <h1 id="guide-empty-title" className="guide-section-title">
          Understand this change
        </h1>
        <p>
          Get oriented before reading the implementation, then explore the parts
          and questions that matter to you.
        </p>
        <Button variant="primary" disabled={guide.loading} onClick={onGenerate}>
          {guide.loading ? "Building guide…" : "Generate guide"}
        </Button>
      </section>
    );
  }

  return (
    <article className="guide" aria-labelledby="guide-title">
      <GuideOrientation
        content={guide.orientation}
        comments={guide.comments}
        loading={guide.loading}
        onComment={onComment}
      />
      <GuideTopics
        topics={guide.topics}
        pendingTopics={pendingTopics}
        comments={guide.comments}
        onOperate={onOperate}
        onComment={onComment}
      />
      <GuideQuestions
        questions={guide.questions}
        pendingQuestions={pendingQuestions}
        comments={guide.comments}
        onOperate={onOperate}
        onComment={onComment}
      />
    </article>
  );
}
