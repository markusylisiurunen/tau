export function formatCodexAuthError(authPath: string, detail?: string): string {
  const base = "OpenAI Codex credentials are missing or expired.";
  const hint = `Run "tau login openai-codex" to authenticate and store tokens in ${authPath}.`;
  return detail ? `${base} ${detail} ${hint}` : `${base} ${hint}`;
}
