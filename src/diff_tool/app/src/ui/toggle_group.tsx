import { Button } from "./button.js";
import "./toggle_group.css";

type ToggleGroupOption<T extends string> = {
  value: T;
  label: string;
};

type ToggleGroupProps<T extends string> = {
  value: T;
  options: ToggleGroupOption<T>[];
  label: string;
  onChange: (value: T) => void;
};

export function ToggleGroup<T extends string>({
  value,
  options,
  label,
  onChange,
}: ToggleGroupProps<T>) {
  return (
    <div className="toggle-group" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <Button
          key={option.value}
          variant="ghost"
          active={value === option.value}
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}
