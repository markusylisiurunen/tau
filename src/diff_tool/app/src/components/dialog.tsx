import { X } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import "./dialog.css";
import { IconButton } from "./icon_button.js";

type DialogProps = {
  open: boolean;
  title: string;
  ariaLabel: string;
  closeLabel: string;
  widthClassName?: string;
  bodyClassName?: string;
  onClose: () => void;
  children: ReactNode;
};

export function Dialog({
  open,
  title,
  ariaLabel,
  closeLabel,
  widthClassName,
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
        className={`dialog${widthClassName ? ` ${widthClassName}` : ""}`}
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
            <IconButton
              icon={X}
              size={16}
              label={closeLabel}
              className="dialog-close"
              onClick={onClose}
            />
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
