import { Sparkles } from "lucide-react";
import type {
  DiffToolGuide,
  DiffToolGuideCommentTarget,
  DiffToolGuideOperation,
} from "../../types.js";
import { Button } from "../../ui/button.js";
import { GuideOrientation } from "./guide_orientation.js";
import { GuideQuestions } from "./guide_questions.js";
import { GuideTopics } from "./guide_topics.js";
import "./guide.css";

type GuideProps = {
  guide: DiffToolGuide;
  onGenerate: () => void;
  onOperate: (operation: DiffToolGuideOperation) => void;
  onComment: (target: DiffToolGuideCommentTarget, body: string) => void;
};

export function Guide({ guide, onGenerate, onOperate, onComment }: GuideProps) {
  if (!guide.orientation.trim()) {
    return (
      <section className="guide-empty" aria-labelledby="guide-empty-title">
        <Sparkles size={20} aria-hidden="true" />
        <h1 id="guide-empty-title">
          {guide.loading
            ? "Building your change guide…"
            : "Understand this change"}
        </h1>
        <p>
          Get oriented before reading the implementation, then explore the parts
          and questions that matter to you.
        </p>
        {!guide.loading && (
          <Button variant="primary" onClick={onGenerate}>
            Generate guide
          </Button>
        )}
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
        comments={guide.comments}
        loading={guide.loading}
        onOperate={onOperate}
        onComment={onComment}
      />
      <GuideQuestions
        questions={guide.questions}
        comments={guide.comments}
        loading={guide.loading}
        onOperate={onOperate}
        onComment={onComment}
      />
    </article>
  );
}
