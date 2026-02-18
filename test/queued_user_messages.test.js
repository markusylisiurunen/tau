import { describe, expect, it } from "vitest";
import { QueuedUserMessages } from "../dist/tui/chat_controller/queued_user_messages.js";

describe("QueuedUserMessages", () => {
  it("drains queued messages in order", async () => {
    const queue = ["first", "second"];
    const manager = new QueuedUserMessages(queue);
    const seen = [];

    await manager.drain({
      isStreaming: () => false,
      onUserInput: async (text) => {
        seen.push(text);
      },
      requestRender: () => {},
      sendTerminalNotification: () => {},
      buildIdleNotificationTitle: () => "idle",
    });

    expect(seen).toEqual(["first", "second"]);
    expect(queue).toEqual([]);
  });

  it("moves queued messages into the editor on dequeue", () => {
    const queue = ["one", "two"];
    const manager = new QueuedUserMessages(queue);
    let editorText = "existing";

    manager.dequeueIntoEditor({
      getEditorText: () => editorText,
      setEditorText: (text) => {
        editorText = text;
      },
    });

    expect(editorText).toBe("existing\n\n---\n\none\n\n---\n\ntwo");
    expect(queue).toEqual([]);
  });

  it("fires pending idle notification once after draining", async () => {
    const queue = [];
    const manager = new QueuedUserMessages(queue);
    const notifications = [];

    manager.markPendingIdleNotification();

    await manager.drain({
      isStreaming: () => false,
      onUserInput: async () => {},
      requestRender: () => {},
      sendTerminalNotification: (title) => {
        notifications.push(title);
      },
      buildIdleNotificationTitle: () => "ready",
    });

    await manager.drain({
      isStreaming: () => false,
      onUserInput: async () => {},
      requestRender: () => {},
      sendTerminalNotification: (title) => {
        notifications.push(title);
      },
      buildIdleNotificationTitle: () => "ready",
    });

    expect(notifications).toEqual(["ready"]);
  });
});
