export function joinQueuedUserMessages(messages: string[]): string {
  return messages.join("\n\n---\n\n");
}
