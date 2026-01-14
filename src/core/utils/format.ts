import { homedir } from "node:os";

export function formatTokenWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${m.toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  }
  if (tokens >= 1_000) {
    const k = tokens / 1_000;
    return `${k.toFixed(tokens % 1_000 === 0 ? 0 : 1)}k`;
  }
  return String(tokens);
}

export function formatAdaptiveNumber(
  value: number,
  minDecimals: number,
  maxDecimals: number,
): string {
  if (!Number.isFinite(value)) return "0";
  if (value === 0) return value.toFixed(minDecimals);

  let decimals = minDecimals;
  let formatted = value.toFixed(decimals);

  while (decimals < maxDecimals && Number(formatted) === 0) {
    decimals += 1;
    formatted = value.toFixed(decimals);
  }

  return formatted;
}

export function formatCwd(cwd: string): string {
  const home = homedir();
  if (cwd === home) return "~";
  if (cwd.startsWith(`${home}/`)) {
    return `~${cwd.slice(home.length)}`;
  }
  return cwd;
}
