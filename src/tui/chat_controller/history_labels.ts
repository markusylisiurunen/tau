export function formatRewindCandidateLabel(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!firstLine) {
    return "(empty user message)";
  }
  return firstLine;
}
