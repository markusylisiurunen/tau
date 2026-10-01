export function formatCodexAuthError(authPath: string, detail?: string): string {
  const base = "OpenAI Codex credentials are missing or expired.";
  const hint = `run "tau auth login codex" to authenticate and store tokens in ${authPath}, or "tau auth use codex --account <email-or-id>" to select a stored account.`;
  return detail ? `${base} ${detail} ${hint}` : `${base} ${hint}`;
}
