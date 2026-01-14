export function inlineText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
