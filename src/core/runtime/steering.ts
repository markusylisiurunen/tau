const STEERING_GUIDANCE =
  "The user sent the following message(s) while you were already working. Treat them as steering for the current task: incorporate them immediately, adjust your plan if needed, and do not continue down the previous path if this changes the requested direction.";

export function formatSteeringUserMessage(messages: string[]): string {
  const body = messages.join("\n\n");

  return `<system>\n${STEERING_GUIDANCE}\n</system>\n${body}`;
}
