import { describe, expect, it } from "vitest";
import { ChatContainerComponent } from "../dist/tui/ui/chat_container.js";
import { createUiTheme } from "../dist/tui/ui/theme/index.js";
import { createToolUiRegistry } from "../dist/tui/ui/tool_ui_registry.js";

function inspectChatContainer(container) {
  return {
    allMessages: container.allMessages,
    idToIndex: container.idToIndex,
  };
}

describe("ChatContainerComponent", () => {
  it("replaces an existing message when adding another message with the same id", () => {
    const container = new ChatContainerComponent(createUiTheme("plain"), createToolUiRegistry());

    container.addMessage({ type: "system", text: "first", kind: "muted" }, "tool-call-id");
    container.addMessage({ type: "system", text: "second", kind: "muted" }, "tool-call-id");

    const state = inspectChatContainer(container);
    expect(state.allMessages).toHaveLength(1);
    expect(state.allMessages[0]).toMatchObject({
      id: "tool-call-id",
      model: { type: "system", text: "second" },
    });
    expect(state.idToIndex.get("tool-call-id")).toBe(0);
  });
});
