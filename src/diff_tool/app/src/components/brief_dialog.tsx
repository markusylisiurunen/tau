import "./brief_dialog.css";
import { Dialog } from "./dialog.js";
import { MarkdownContent } from "./markdown_content.js";

type BriefDialogProps = {
  open: boolean;
  content: string;
  loading: boolean;
  onClose: () => void;
};

export function BriefDialog({
  open,
  content,
  loading,
  onClose,
}: BriefDialogProps) {
  return (
    <Dialog
      open={open}
      title="brief"
      ariaLabel="Reviewer brief"
      closeLabel="close brief"
      bodyClassName="brief-dialog-body-wrap"
      onClose={onClose}
    >
      {loading && !content ? (
        <div className="brief-dialog-empty">Generating brief…</div>
      ) : (
        <MarkdownContent
          content={content}
          className="brief-dialog-body"
          variant="brief"
        />
      )}
    </Dialog>
  );
}
