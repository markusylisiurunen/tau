import { describe, expect, it } from "vitest";
import { ChatContainerComponent } from "../dist/tui/ui/chat_container.js";
import { createUiTheme } from "../dist/tui/ui/theme/index.js";

function inspectChatContainer(container) {
  return {
    allMessages: container.allMessages,
    idToIndex: container.idToIndex,
  };
}

describe("ChatContainerComponent", () => {
  it("replaces an existing message when adding another message with the same id", () => {
    const container = new ChatContainerComponent(createUiTheme("plain"));

    container.addMessage(
      { type: "transcript_notice", title: "first", tone: "default" },
      "tool-call-id",
    );
    container.addMessage(
      { type: "transcript_notice", title: "second", tone: "default" },
      "tool-call-id",
    );

    const state = inspectChatContainer(container);
    expect(state.allMessages).toHaveLength(1);
    expect(state.allMessages[0]).toMatchObject({
      id: "tool-call-id",
      model: { type: "transcript_notice", title: "second" },
    });
    expect(state.idToIndex.get("tool-call-id")).toBe(0);
  });
});
