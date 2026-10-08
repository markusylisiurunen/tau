import {
  parseAutoCompactThresholdTokens,
  type SessionProtocolSettingsSnapshot,
} from "../../protocol/session_protocol.js";

export function parseAutoCompactThreshold(input: string): number | null | undefined {
  const text = input.trim();
  if (!text) return undefined;
  if (text === "default") return null;
  if (!/^\d+(?:k)?$/i.test(text))
    throw new Error("use a token count such as 50000 or 50k, or default");
  const value = Number(text.replace(/k$/i, "")) * (/k$/i.test(text) ? 1000 : 1);
  return parseAutoCompactThresholdTokens(value);
}

export function formatAutoCompactThreshold(settings: SessionProtocolSettingsSnapshot): string {
  return `auto-compact is set to ${settings.autoCompactThresholdTokens === null ? "default" : `${settings.autoCompactThresholdTokens} tokens`}; effective threshold is ${settings.effectiveAutoCompactThresholdTokens} tokens.`;
}
