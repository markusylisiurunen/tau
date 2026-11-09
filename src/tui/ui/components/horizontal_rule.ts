import { visibleWidth } from "@earendil-works/pi-tui";
import { truncateFromEndByWidth } from "./one_line_segments.js";

type RuleLabel = { text: string; style: (text: string) => string };

export function renderHorizontalRule(
  width: number,
  options: {
    style: (text: string) => string;
    left?: RuleLabel;
    right?: RuleLabel;
  },
): string {
  if (width <= 0) return "";
  if (width <= 4) return options.style("─".repeat(width));

  let left = options.left?.text.trim() ?? "";
  let right = options.right?.text.trim() ?? "";
  const labelWidth = (text: string) => (text ? visibleWidth(text) + 2 : 0);
  const available = width - 4;

  if (labelWidth(left) + labelWidth(right) > available) {
    left = truncateFromEndByWidth(left, Math.max(0, available - labelWidth(right) - 2));
  }
  if (labelWidth(left) + labelWidth(right) > available) {
    right = truncateFromEndByWidth(right, Math.max(0, available - labelWidth(left) - 2));
  }

  const leftSegment = left && options.left ? ` ${options.left.style(left)} ` : "";
  const rightSegment = right && options.right ? ` ${options.right.style(right)} ` : "";
  const fillWidth = available - labelWidth(left) - labelWidth(right);
  return `${options.style("──")}${leftSegment}${options.style("─".repeat(fillWidth))}${rightSegment}${options.style("──")}`;
}
