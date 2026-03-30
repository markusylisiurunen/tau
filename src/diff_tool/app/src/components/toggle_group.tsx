import "./toggle_group.css";

type ToggleGroupProps<T extends string> = {
  value: T;
  options: T[];
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
          key={option}
          type="button"
          role="radio"
          aria-checked={value === option}
          className={`toggle-group-item${value === option ? " active" : ""}`}
          onClick={() => onChange(option)}
        >
          {option}
        </button>
      ))}
    </div>
  );
}
