import { memo, useEffect, useRef } from "react";
import "./comment_editor.css";

type CommentEditorProps = {
  body: string;
  onChange: (body: string) => void;
  onSave: () => void;
  onCancel: () => void;
};

export const CommentEditor = memo(function CommentEditor({
  body,
  onChange,
  onSave,
  onCancel,
}: CommentEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSave();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="comment-editor">
      <textarea
        ref={ref}
        className="text-input-area comment-input"
        value={body}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Add a comment…"
        rows={2}
      />
      <div className="comment-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>
          cancel
        </button>
        <button type="button" className="btn primary" onClick={onSave}>
          comment
        </button>
      </div>
    </div>
  );
});
