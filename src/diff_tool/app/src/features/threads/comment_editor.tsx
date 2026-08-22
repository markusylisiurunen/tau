import { memo, useState } from "react";
import { Checkbox } from "../../ui/checkbox.js";
import { TextComposer } from "../../ui/text_composer.js";
import "./comment_editor.css";

type CommentEditorProps = {
  onSave: (body: string, requestAgent: boolean) => void;
  onCancel: () => void;
};

export const CommentEditor = memo(function CommentEditor({
  onSave,
  onCancel,
}: CommentEditorProps) {
  const [requestAgent, setRequestAgent] = useState(false);

  return (
    <TextComposer
      className="comment-editor"
      inputClassName="comment-input"
      actionsClassName="comment-actions"
      placeholder="Add a comment…"
      submitLabel="comment"
      rows={2}
      autoFocus
      allowEmptySubmit
      onSubmit={(body) => onSave(body, requestAgent)}
      onCancel={onCancel}
    >
      <Checkbox
        checked={requestAgent}
        label="ask agent"
        onChange={setRequestAgent}
      />
    </TextComposer>
  );
});
