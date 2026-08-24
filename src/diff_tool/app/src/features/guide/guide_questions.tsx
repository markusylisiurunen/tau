import { ChevronRight } from "lucide-react";
import { useState } from "react";
import type {
  DiffToolGuideComment,
  DiffToolGuideCommentTarget,
  DiffToolGuideOperation,
  DiffToolGuideQuestion,
} from "../../types.js";
import { Button } from "../../ui/button.js";
import { MarkdownContent } from "../../ui/markdown_content.js";
import {
  GuideFeedbackCard,
  GuideFeedbackFormCard,
} from "./guide_feedback_card.js";
import type { PendingGuideQuestion } from "./use_guide.js";
import "./guide_questions.css";

type GuideQuestionsProps = {
  questions: DiffToolGuideQuestion[];
  pendingQuestions: PendingGuideQuestion[];
  comments: DiffToolGuideComment[];
  onOperate: (operation: DiffToolGuideOperation) => void;
  onComment: (target: DiffToolGuideCommentTarget, body: string) => void;
};

export function GuideQuestions({
  questions,
  pendingQuestions,
  comments,
  onOperate,
  onComment,
}: GuideQuestionsProps) {
  const [requestOpen, setRequestOpen] = useState(false);

  return (
    <section className="guide-section" aria-labelledby="guide-questions-title">
      <header className="guide-section-heading">
        <h2 id="guide-questions-title" className="guide-section-title">
          Questions
        </h2>
      </header>

      {(questions.length > 0 || pendingQuestions.length > 0) && (
        <ul className="guide-question-list">
          {questions.map((question) => (
            <li key={question.id} className="guide-question-item">
              <details className="guide-question">
                <summary>
                  <ChevronRight className="guide-question-icon" size={16} />
                  <span className="guide-question-label">
                    <strong>{question.question}</strong>
                  </span>
                </summary>
                <div className="guide-question-answer">
                  <MarkdownContent content={question.answer} variant="guide" />
                  <GuideFeedbackCard
                    comments={comments}
                    target={{ kind: "question", questionId: question.id }}
                    onComment={onComment}
                  />
                </div>
              </details>
            </li>
          ))}
          {pendingQuestions.map((question) => (
            <li key={question.id} className="guide-question-item">
              <div
                className="guide-question-pending"
                role="status"
                aria-label={`${question.question}, generating answer`}
              >
                <span className="guide-question-label">
                  <strong>{question.question}</strong>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {requestOpen ? (
        <GuideFeedbackFormCard
          label="Ask a question"
          placeholder="Write the question you want answered…"
          submitLabel="Ask"
          onClose={() => setRequestOpen(false)}
          onSubmit={(question) => {
            onOperate({ kind: "question.ask", question });
            setRequestOpen(false);
          }}
        />
      ) : (
        <div className="guide-question-actions">
          <Button variant="ghost" onClick={() => setRequestOpen(true)}>
            Ask a question
          </Button>
        </div>
      )}
    </section>
  );
}
