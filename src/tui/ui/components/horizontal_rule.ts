import { visibleWidth } from "@earendil-works/pi-tui";
import { truncateFromEndByWidth } from "./one_line_segments.js";

export function renderHorizontalRule(
  width: number,
  options: {
    style: (text: string) => string;
    left?: string;
    right?: string;
  },
): string {
  if (width <= 0) return "";

  let left = options.left?.trim() ?? "";
  let right = options.right?.trim() ?? "";
  const labelWidth = (text: string) => (text ? visibleWidth(text) + 1 : 0);

  if (labelWidth(left) + labelWidth(right) > width) {
    left = truncateFromEndByWidth(left, Math.max(0, width - labelWidth(right) - 1));
  }
  if (labelWidth(left) + labelWidth(right) > width) {
    right = truncateFromEndByWidth(right, Math.max(0, width - labelWidth(left) - 1));
  }

  const leftSegment = left ? `${left} ` : "";
  const rightSegment = right ? ` ${right}` : "";
  const fillWidth = width - labelWidth(left) - labelWidth(right);
  return options.style(`${leftSegment}${"─".repeat(fillWidth)}${rightSegment}`);
}
