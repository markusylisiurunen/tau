import type { ButtonHTMLAttributes } from "react";
import "./button.css";

type ButtonVariant = "default" | "primary" | "ghost" | "danger" | "unstyled";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  active?: boolean;
  muted?: boolean;
  iconOnly?: boolean;
  pill?: boolean;
};

export function Button({
  variant = "default",
  active = false,
  muted = false,
  iconOnly = false,
  pill = false,
  type = "button",
  className,
  ...props
}: ButtonProps) {
  const resolvedClassName = [
    "button",
    `button-${variant}`,
    active && "button-active",
    muted && "button-muted",
    iconOnly && "button-icon-only",
    pill && "button-pill",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return <button {...props} type={type} className={resolvedClassName} />;
}
