import { memo, useEffect, useRef } from "react";
import "./comment_editor.css";

type CommentEditorProps = {
  onSave: (body: string) => void;
  onCancel: () => void;
};

export const CommentEditor = memo(function CommentEditor({
  onSave,
  onCancel,
}: CommentEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const submit = () => {
    const body = ref.current?.value ?? "";
    onSave(body);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
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
        onKeyDown={handleKeyDown}
        placeholder="Add a comment…"
        rows={2}
      />
      <div className="comment-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>
          cancel
        </button>
        <button type="button" className="btn primary" onClick={submit}>
          comment
        </button>
      </div>
    </div>
  );
});
