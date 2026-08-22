import { useState, type ReactNode } from "react";
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
  disabled?: boolean;
  allowEmptySubmit?: boolean;
  children?: ReactNode;
  onValueChange?: (value: string) => void;
  onSubmit: (value: string) => void;
  onCancel?: () => void;
  onEscape?: () => void;
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
  disabled = false,
  allowEmptySubmit = false,
  children,
  onValueChange,
  onSubmit,
  onCancel,
  onEscape,
}: TextComposerProps) {
  const [internalValue, setInternalValue] = useState("");
  const currentValue = value ?? internalValue;
  const trimmedValue = currentValue.trim();

  const updateValue = (nextValue: string) => {
    if (value === undefined) {
      setInternalValue(nextValue);
    }
    onValueChange?.(nextValue);
  };

  const submit = () => {
    if ((!trimmedValue && !allowEmptySubmit) || disabled) {
      return;
    }
    if (value === undefined) {
      setInternalValue("");
    }
    onSubmit(trimmedValue);
  };

  const textarea = (
    <textarea
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
        if (event.key === "Escape" && (onEscape || onCancel)) {
          event.preventDefault();
          (onEscape ?? onCancel)?.();
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
          disabled={(!trimmedValue && !allowEmptySubmit) || disabled}
        >
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
