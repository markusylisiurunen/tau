import { describe, expect, it, vi } from "vitest";
import { TuiChatView } from "../dist/tui/chat_view.js";
import { ChatContainerComponent } from "../dist/tui/ui/chat_container.js";
import { createUiTheme } from "../dist/tui/ui/theme/index.js";

function inspectChatContainer(container) {
  return {
    allMessages: container.allMessages,
    idToIndex: container.idToIndex,
  };
}

describe("ChatContainerComponent", () => {
  it("retains hidden thinking without invalidating or requesting a render", () => {
    const container = new ChatContainerComponent(createUiTheme("plain"));
    container.addMessage({ type: "assistant_partial", text: "answer", thinking: "first" }, "a");
    const lines = container.render(80);
    const component = container.allMessages[0].renderedMessage.component;
    const requestRender = vi.fn();
    const view = Object.create(TuiChatView.prototype);
    view.chatContainer = container;
    view.ui = { requestRender };

    view.updateAssistantMessage("a", {
      type: "assistant_partial",
      text: "answer",
      thinking: "first and second",
    });

    expect(requestRender).not.toHaveBeenCalled();
    expect(container.render(80)).toBe(lines);
    expect(container.allMessages[0].renderedMessage.component).toBe(component);
    container.setThinkingVisibility(true);
    expect(container.render(80).join("\n")).toContain("first and second");
    view.updateAssistantMessage("a", {
      type: "assistant_partial",
      text: "answer",
      thinking: "third",
    });
    expect(requestRender).toHaveBeenCalledTimes(1);
    expect(container.render(80).join("\n")).toContain("third");

    container.setThinkingVisibility(false);
    view.updateAssistantMessage("a", {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "final answer" }] },
    });
    expect(requestRender).toHaveBeenCalledTimes(2);
    expect(container.render(80).join("\n")).toContain("final answer");
  });

  it.each([0, 500, 1000])(
    "preserves components when visibility changes at position %i",
    (position) => {
      const container = new ChatContainerComponent(createUiTheme("plain"));
      for (let index = 0; index <= 1000; index += 1) {
        if (index === position) {
          container.addMessage({ type: "assistant_partial", text: "", thinking: "hidden" }, "a");
        }
        if (index < 1000) {
          container.addMessage(
            { type: "assistant_partial", text: `message ${index}` },
            `m${index}`,
          );
        }
      }
      const lines = container.render(80);
      const components = container.allMessages.map((record) => record.renderedMessage.component);
      expect(
        container.updateMessage("a", {
          type: "assistant_partial",
          text: "",
          thinking: "more hidden",
        }),
      ).toBe("unchanged");
      expect(container.render(80)).toBe(lines);

      for (const text of ["visible", "", "visible again"]) {
        expect(container.updateMessage("a", { type: "assistant_partial", text })).toBe("updated");
        container.allMessages.forEach((record, index) => {
          expect(record.renderedMessage.component).toBe(components[index]);
        });
        const expected = new ChatContainerComponent(createUiTheme("plain"));
        for (const record of container.allMessages) expected.addMessage(record.model, record.id);
        expect(container.render(80)).toEqual(expected.render(80));
      }
    },
  );

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
