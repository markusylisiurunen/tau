export function getEffectiveAutoCompactThresholdTokens(
  contextWindow: number,
  thresholdTokens: number | null,
): number {
  return Math.min(thresholdTokens ?? Infinity, contextWindow - 16_384);
}
