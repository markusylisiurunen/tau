import type { LucideIcon } from "lucide-react";
import type { ButtonHTMLAttributes } from "react";

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon;
  label: string;
  size?: number;
};

export function IconButton({
  icon: Icon,
  label,
  size = 14,
  className = "",
  ...props
}: IconButtonProps) {
  return (
    <button
      type="button"
      className={`icon-btn ${className}`}
      aria-label={label}
      {...props}
    >
      <Icon size={size} />
    </button>
  );
}
