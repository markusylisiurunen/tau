// Important: Keep this in sync with the Codex static instructions in pi-ai.
const STATIC_PREFIX =
  "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

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
