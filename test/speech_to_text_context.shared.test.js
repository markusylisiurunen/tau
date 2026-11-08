import { describe, expect, it } from "vitest";
import { collectSpeechToTextContext } from "../dist/core/utils/speech_to_text_context.js";

function userMessage(id, text) {
  return {
    id,
    state: "committed",
    modelVisible: true,
    message: { role: "user", content: text, timestamp: 1 },
  };
}

function assistantMessage(id, text, content = [{ type: "text", text }]) {
  return {
    id,
    state: "committed",
    modelVisible: true,
    message: { role: "assistant", content, timestamp: 1 },
  };
}

function snapshot(messages) {
  return { messages };
}

describe("speech-to-text context", () => {
  it("collects user messages and assistant final responses from the last two turns", () => {
    const context = collectSpeechToTextContext(
      snapshot([
        userMessage("user-1", "first user"),
        assistantMessage("assistant-1", "first assistant"),
        userMessage("user-2", "second user"),
        assistantMessage("assistant-tool", "checking", [
          { type: "text", text: "checking" },
          { type: "toolCall", id: "tool-1", name: "bash", arguments: {} },
        ]),
        assistantMessage("assistant-2", "second assistant"),
        userMessage("user-3", "third user"),
        assistantMessage("assistant-3", "third assistant"),
      ]),
    );

    expect(context.messages).toEqual([
      { role: "user", text: "second user" },
      { role: "assistant", text: "second assistant" },
      { role: "user", text: "third user" },
      { role: "assistant", text: "third assistant" },
    ]);
  });

  it("middle-truncates each context message to 4096 tokens", () => {
    const longText = `${"a".repeat(13_000)} middle ${"z".repeat(13_000)}`;

    const context = collectSpeechToTextContext(
      snapshot([userMessage("user-1", longText), assistantMessage("assistant-1", longText)]),
    );

    expect(context.messages).toHaveLength(2);
    for (const message of context.messages) {
      expect(message.text).toContain("a".repeat(100));
      expect(message.text).toContain("tokens truncated");
      expect(message.text).toContain("z".repeat(100));
      expect(message.text).not.toContain(" middle ");
    }
  });
});
