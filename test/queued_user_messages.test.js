import { describe, expect, it } from "vitest";
import { joinQueuedUserMessages } from "../dist/tui/chat_controller/queued_user_messages.js";

describe("joinQueuedUserMessages", () => {
  it("joins restored pending messages with editor separators", () => {
    expect(joinQueuedUserMessages(["existing", "steer", "queued"])).toBe(
      "existing\n\n---\n\nsteer\n\n---\n\nqueued",
    );
  });
});
