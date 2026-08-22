import { X } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { Button } from "./button.js";
import "./dialog.css";

type DialogProps = {
  open: boolean;
  title: string;
  ariaLabel: string;
  closeLabel: string;
  bodyClassName?: string;
  onClose: () => void;
  children: ReactNode;
};

export function Dialog({
  open,
  title,
  ariaLabel,
  closeLabel,
  bodyClassName,
  onClose,
  children,
}: DialogProps) {
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
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-header">
          <div className="dialog-heading">
            <div className="dialog-title">{title}</div>
          </div>
          <div className="dialog-actions">
            <Button
              variant="ghost"
              iconOnly
              aria-label={closeLabel}
              onClick={onClose}
            >
              <X size={16} />
            </Button>
          </div>
        </div>
        <div
          className={`dialog-body-wrap${bodyClassName ? ` ${bodyClassName}` : ""}`}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
