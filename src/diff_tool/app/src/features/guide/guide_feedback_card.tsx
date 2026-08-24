import { useEffect, useState, type ReactNode } from "react";
import {
  type DiffToolGuideComment,
  type DiffToolGuideCommentTarget,
  guideCommentTargetKey,
} from "../../types.js";
import { Button } from "../../ui/button.js";
import { TextComposer } from "../../ui/text_composer.js";
import { ToggleGroup } from "../../ui/toggle_group.js";
import "./guide_feedback_card.css";

type GuideFeedbackMode = "comment" | "changes";

type ChangeRequest = {
  placeholder: string;
  submitLabel: string;
  onSubmit: (request: string) => void;
};

type GuideFeedbackCardProps = {
  target: DiffToolGuideCommentTarget;
  comments: DiffToolGuideComment[];
  requestChanges?: ChangeRequest;
  onComment: (target: DiffToolGuideCommentTarget, body: string) => void;
};

type GuideFeedbackFormCardProps = {
  label: string;
  heading?: ReactNode;
  placeholder: string;
  submitLabel: string;
  value?: string;
  allowEmptySubmit?: boolean;
  onValueChange?: (value: string) => void;
  onClose: () => void;
  onSubmit: (value: string) => void;
};

export function GuideFeedbackCard({
  target,
  comments,
  requestChanges,
  onComment,
}: GuideFeedbackCardProps) {
  const [mode, setMode] = useState<GuideFeedbackMode | null>(null);
  const targetKey = guideCommentTargetKey(target);
  const comment = comments.find(
    (entry) => guideCommentTargetKey(entry.target) === targetKey,
  );
  const commentLabel = comment?.body.trim()
    ? "Edit your comment"
    : "Write a comment";
  const feedbackModes: Array<{ value: GuideFeedbackMode; label: string }> = [
    { value: "comment", label: commentLabel },
    { value: "changes", label: "Ask for changes" },
  ];
  const [commentDraft, setCommentDraft] = useState(comment?.body ?? "");

  useEffect(() => {
    setCommentDraft(comment?.body ?? "");
  }, [comment?.body]);

  useEffect(() => {
    if (!requestChanges && mode === "changes") {
      setMode(null);
    }
  }, [mode, requestChanges]);

  if (mode === null) {
    return (
      <div className="guide-feedback-actions" aria-label="Feedback">
        <Button variant="ghost" onClick={() => setMode("comment")}>
          {commentLabel}
        </Button>
        {requestChanges && (
          <Button variant="ghost" onClick={() => setMode("changes")}>
            Ask for changes
          </Button>
        )}
      </div>
    );
  }

  const heading = requestChanges ? (
    <ToggleGroup
      value={mode}
      options={feedbackModes}
      label="Feedback mode"
      onChange={setMode}
    />
  ) : undefined;

  if (mode === "changes" && requestChanges) {
    return (
      <GuideFeedbackFormCard
        label="Feedback"
        heading={heading}
        placeholder={requestChanges.placeholder}
        submitLabel={requestChanges.submitLabel}
        onClose={() => setMode(null)}
        onSubmit={(request) => {
          requestChanges.onSubmit(request);
          setMode(null);
        }}
      />
    );
  }

  return (
    <GuideFeedbackFormCard
      label="Feedback"
      heading={heading}
      placeholder="Write your review comment…"
      submitLabel="Save comment"
      value={commentDraft}
      allowEmptySubmit={Boolean(comment)}
      onValueChange={setCommentDraft}
      onClose={() => setMode(null)}
      onSubmit={(body) => {
        onComment(target, body);
        setMode(null);
      }}
    />
  );
}

export function GuideFeedbackFormCard({
  label,
  heading,
  placeholder,
  submitLabel,
  value,
  allowEmptySubmit,
  onValueChange,
  onClose,
  onSubmit,
}: GuideFeedbackFormCardProps) {
  return (
    <aside className="guide-feedback-card" aria-label={label}>
      {heading && (
        <header className="guide-feedback-card-heading">{heading}</header>
      )}
      <TextComposer
        className="guide-feedback-form"
        inputClassName="guide-feedback-input"
        actionsClassName="guide-feedback-footer"
        placeholder={placeholder}
        submitLabel={submitLabel}
        cancelLabel="Close"
        value={value}
        autoFocus
        allowEmptySubmit={allowEmptySubmit}
        onValueChange={onValueChange}
        onCancel={onClose}
        onSubmit={onSubmit}
      />
    </aside>
  );
}
