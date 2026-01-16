import { PI_STATIC_INSTRUCTIONS } from "@mariozechner/pi-ai";

const STATIC_PREFIX = PI_STATIC_INSTRUCTIONS.trim();

export function ensureCodexSystemPrompt(systemPrompt: string): string {
  const trimmedStart = systemPrompt.trimStart();
  if (trimmedStart.startsWith(STATIC_PREFIX)) {
    return STATIC_PREFIX + trimmedStart.slice(STATIC_PREFIX.length);
  }

  if (!systemPrompt.trim()) {
    return STATIC_PREFIX;
  }

  return `${STATIC_PREFIX}\n\n${systemPrompt.trim()}`;
}
