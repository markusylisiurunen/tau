import type { ButtonHTMLAttributes } from "react";
import "./button.css";

type ButtonVariant = "default" | "primary" | "ghost" | "danger";

type ButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "className"
> & {
  variant?: ButtonVariant;
  active?: boolean;
  muted?: boolean;
  fullWidth?: boolean;
  iconOnly?: boolean;
  pill?: boolean;
};

export function Button({
  variant = "default",
  active = false,
  muted = false,
  fullWidth = false,
  iconOnly = false,
  pill = false,
  type = "button",
  ...props
}: ButtonProps) {
  const className = [
    "button",
    `button-${variant}`,
    active && "button-active",
    muted && "button-muted",
    fullWidth && "button-full-width",
    iconOnly && "button-icon-only",
    pill && "button-pill",
  ]
    .filter(Boolean)
    .join(" ");

  return <button {...props} type={type} className={className} />;
}
