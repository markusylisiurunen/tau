import { useEffect, useRef } from "react";
import "./button.css";
import "./comment_editor.css";

type CommentEditorProps = {
  body: string;
  onChange: (body: string) => void;
  onSave: () => void;
  onCancel: () => void;
};

export function CommentEditor({
  body,
  onChange,
  onSave,
  onCancel,
}: CommentEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSave();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="comment-editor">
      <textarea
        ref={ref}
        className="comment-input"
        value={body}
        onChange={(e) => onChange(e.target.value)}
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
}
