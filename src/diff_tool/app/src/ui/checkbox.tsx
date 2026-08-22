import { Check } from "lucide-react";
import "./checkbox.css";

type CheckboxProps = {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
  className?: string;
};

export function Checkbox({
  checked,
  label,
  onChange,
  className,
}: CheckboxProps) {
  return (
    <label className={`checkbox-btn${className ? ` ${className}` : ""}`}>
      <input
        type="checkbox"
        className="checkbox-input"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="checkbox-box" aria-hidden="true">
        {checked && <Check size={10} strokeWidth={3} />}
      </span>
      <span>{label}</span>
    </label>
  );
}
