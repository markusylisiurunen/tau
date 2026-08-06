import { formatAdaptiveNumber } from "../../core/utils/format.js";

export function formatDurationMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const minutesTotal = Math.floor(totalSeconds / 60);
  const minutes = minutesTotal % 60;
  const hours = Math.floor(minutesTotal / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  if (minutesTotal > 0) {
    return `${minutesTotal}m ${seconds}s`;
  }

  return `${seconds}s`;
}

export function formatFooterTokenCount(tokens: number): string {
  if (tokens < 1_000) {
    return String(tokens);
  }

  let divisor = 1_000;
  let suffix = "k";
  let scaled = tokens / divisor;
  let precision = scaled < 10 ? 10 : 1;
  let rounded = Math.round((scaled + Number.EPSILON) * precision) / precision;

  if (rounded >= 1_000) {
    divisor = 1_000_000;
    suffix = "M";
    scaled = tokens / divisor;
    precision = scaled < 10 ? 10 : 1;
    rounded = Math.round((scaled + Number.EPSILON) * precision) / precision;
  }

  return `${rounded}${suffix}`;
}

export function formatSessionCost(total: number): string {
  return `$${formatAdaptiveNumber(total, 2, 5)}`;
}

export function formatSessionPercent(percent: number): string {
  return formatAdaptiveNumber(percent, 1, 3);
}
