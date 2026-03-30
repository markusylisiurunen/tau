import { useEffect } from "react";
import { X } from "lucide-react";
import { IconButton } from "./icon_button.js";
import { MarkdownContent } from "./markdown_content.js";
import "./brief_dialog.css";

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
  useEffect(() => {
    if (!open) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div className="brief-dialog-backdrop" onClick={onClose}>
      <div
        className="brief-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Reviewer brief"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="brief-dialog-header">
          <div className="brief-dialog-heading">
            <div className="brief-dialog-title">brief</div>
          </div>
          <div className="brief-dialog-actions">
            <IconButton
              icon={X}
              label="close brief"
              className="brief-dialog-close"
              onClick={onClose}
            />
          </div>
        </div>
        <div className="brief-dialog-body-wrap">
          {loading && !content ? (
            <div className="brief-dialog-empty">Generating brief…</div>
          ) : (
            <MarkdownContent
              content={content}
              className="brief-dialog-body"
              variant="brief"
            />
          )}
        </div>
      </div>
    </div>
  );
}
