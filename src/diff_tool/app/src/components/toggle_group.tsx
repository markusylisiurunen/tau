import "./toggle_group.css";

type ToggleGroupOption<T extends string> = {
  value: T;
  label: string;
};

type ToggleGroupProps<T extends string> = {
  value: T;
  options: ToggleGroupOption<T>[];
  onChange: (value: T) => void;
};

export function ToggleGroup<T extends string>({
  value,
  options,
  onChange,
}: ToggleGroupProps<T>) {
  return (
    <div className="toggle-group" role="radiogroup">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          className={`toggle-group-item${value === option.value ? " active" : ""}`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
