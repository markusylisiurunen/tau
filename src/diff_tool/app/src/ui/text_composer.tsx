import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "./button.js";

type TextComposerProps = {
  className?: string;
  inputClassName?: string;
  actionsClassName?: string;
  placeholder: string;
  submitLabel: string;
  cancelLabel?: string;
  value?: string;
  rows?: number;
  autoFocus?: boolean;
  allowEmptySubmit?: boolean;
  children?: ReactNode;
  onValueChange?: (value: string) => void;
  onSubmit: (value: string) => void;
  onCancel?: () => void;
};

export function TextComposer({
  className,
  inputClassName,
  actionsClassName,
  placeholder,
  submitLabel,
  cancelLabel = "Cancel",
  value,
  rows = 3,
  autoFocus = false,
  allowEmptySubmit = false,
  children,
  onValueChange,
  onSubmit,
  onCancel,
}: TextComposerProps) {
  const [internalValue, setInternalValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const currentValue = value ?? internalValue;
  const trimmedValue = currentValue.trim();

  useEffect(() => {
    if (autoFocus) {
      textareaRef.current?.focus();
    }
  }, [autoFocus]);

  const updateValue = (nextValue: string) => {
    if (value === undefined) {
      setInternalValue(nextValue);
    }
    onValueChange?.(nextValue);
  };

  const submit = () => {
    if (!trimmedValue && !allowEmptySubmit) {
      return;
    }
    if (value === undefined) {
      setInternalValue("");
    }
    onSubmit(trimmedValue);
  };

  const textarea = (
    <textarea
      ref={textareaRef}
      className={["text-input-area", inputClassName].filter(Boolean).join(" ")}
      value={currentValue}
      rows={rows}
      autoFocus={autoFocus}
      placeholder={placeholder}
      onChange={(event) => updateValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          submit();
        }
        if (event.key === "Escape" && onCancel) {
          event.preventDefault();
          onCancel();
        }
      }}
    />
  );

  return (
    <form
      className={className}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {textarea}
      <div className={actionsClassName}>
        {children}
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            {cancelLabel}
          </Button>
        )}
        <Button
          type="submit"
          variant="primary"
          disabled={!trimmedValue && !allowEmptySubmit}
        >
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
