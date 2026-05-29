import { memo, useEffect, useRef, useState } from "react";
import { Checkbox } from "./checkbox.js";
import "./comment_editor.css";

type CommentEditorProps = {
  onSave: (body: string, requestAgent: boolean) => void;
  onCancel: () => void;
};

export const CommentEditor = memo(function CommentEditor({
  onSave,
  onCancel,
}: CommentEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [requestAgent, setRequestAgent] = useState(false);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const submit = () => {
    const body = ref.current?.value ?? "";
    onSave(body, requestAgent);
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
        <Checkbox
          checked={requestAgent}
          label="ask agent"
          onChange={setRequestAgent}
        />
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
