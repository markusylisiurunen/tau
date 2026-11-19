export function replaceExactText(content: string, oldText: string, newText: string): string {
  const first = content.indexOf(oldText);
  if (!oldText || first === -1) {
    const trimmed = oldText.trim();
    const hint =
      trimmed && trimmed !== oldText && content.includes(trimmed)
        ? " Hint: Found matches when ignoring leading/trailing whitespace."
        : "";
    throw Object.assign(
      new Error(
        `No exact match for oldText was found in the file. Read the file first to see its current content.${hint}`,
      ),
      { code: "edit_no_match" },
    );
  }
  // Overlapping occurrences count too, so `ana` in `banana` is ambiguous. One more match
  // settles it, and counting the rest could scan repetitive text many times.
  if (content.indexOf(oldText, first + 1) !== -1) {
    throw Object.assign(
      new Error(
        "Found more than one match for oldText, but exactly 1 is required. Make oldText more specific to match only one location.",
      ),
      { code: "edit_ambiguous" },
    );
  }
  return content.slice(0, first) + newText + content.slice(first + oldText.length);
}
