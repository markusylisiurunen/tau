export function formatCodexAuthError(authPath: string, detail?: string): string {
  const base = "OpenAI Codex credentials are missing or expired.";
  const hint = `run "tau auth login codex" to authenticate and store tokens in ${authPath}.`;
  return detail ? `${base} ${detail} ${hint}` : `${base} ${hint}`;
}
