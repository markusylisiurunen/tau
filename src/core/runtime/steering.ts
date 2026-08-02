import { formatTauUserText, type TauUserMetadata } from "../utils/user_metadata.js";

const STEERING_GUIDANCE =
  "The user sent the following message(s) while you were already working. Treat them as steering for the current task: incorporate them immediately, adjust your plan if needed, and do not continue down the previous path if this changes the requested direction.";

export function formatSteeringUserMessage(
  messages: string[],
  metadata: readonly TauUserMetadata[] = [],
): string {
  return formatTauUserText({
    text: messages.join("\n\n"),
    metadata,
    hiddenSystemMessages: [STEERING_GUIDANCE],
  });
}
