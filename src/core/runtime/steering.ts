import { formatTauUserText, type TauUserMetadata } from "../utils/user_metadata.js";

const STEERING_GUIDANCE =
  "The user sent this while you were working. Treat it as steering for the current task. Take it into account right away, and change course if it changes what the user wants.";

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
