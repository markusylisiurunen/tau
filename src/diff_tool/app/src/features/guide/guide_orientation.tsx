import type {
  DiffToolGuideComment,
  DiffToolGuideCommentTarget,
} from "../../types.js";
import { MarkdownContent } from "../../ui/markdown_content.js";
import { GuideFeedbackCard } from "./guide_feedback_card.js";

type GuideOrientationProps = {
  content: string;
  comments: DiffToolGuideComment[];
  loading: boolean;
  onComment: (target: DiffToolGuideCommentTarget, body: string) => void;
};

export function GuideOrientation({
  content,
  comments,
  loading,
  onComment,
}: GuideOrientationProps) {
  return (
    <section className="guide-section" aria-labelledby="guide-title">
      <header className="guide-section-heading">
        <h2 id="guide-title" className="guide-section-title">
          Orientation
        </h2>
        {loading && <output className="guide-loading">Updating…</output>}
      </header>
      <MarkdownContent content={content} variant="guide" />
      <GuideFeedbackCard
        comments={comments}
        target={{ kind: "orientation" }}
        onComment={onComment}
      />
    </section>
  );
}
