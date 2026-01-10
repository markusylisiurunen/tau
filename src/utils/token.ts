// this is not accurate, but it's a good-enough estimate. OpenAI suggests 4 bytes per token as a
// cheap heuristic, but in practice it seems to be slightly too low. we use 6 bytes per token, which
// is a good enough safeguard.
// see: https://cookbook.openai.com/examples/gpt-5/gpt-5-1-codex-max_prompting_guide
export const BYTES_PER_TOKEN = 6;

export function tokensToBytes(tokens: number): number {
  return tokens * BYTES_PER_TOKEN;
}

export function bytesToTokens(bytes: number): number {
  return Math.floor(bytes / BYTES_PER_TOKEN);
}

export function formatTokenEstimate(bytes: number): string {
  const tokens = Math.max(0, bytesToTokens(bytes));
  const label = tokens === 1 ? "token" : "tokens";
  return `~${tokens} ${label}`;
}
