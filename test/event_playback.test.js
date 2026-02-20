import { describe, expect, it } from "vitest";
import { createPlaybackHarness } from "./helpers/event_playback.js";

describe("core event playback", () => {
  it("inserts assistant partials only when text starts or thinking is visible", () => {
    const playback = createPlaybackHarness();

    playback.playEvents([
      { type: "assistant_start", historyEntryId: "assistant-1" },
      {
        type: "assistant_partial",
        historyEntryId: "assistant-1",
        snapshot: { text: "", thinking: "hmm", hasTextStarted: false, hasAnyThinking: true },
      },
    ]);

    const inserted = playback.calls.added.filter(
      (entry) => entry.model.type === "assistant_partial",
    );
    expect(inserted.length).toBe(0);

    playback.controller.getInputHandlers().onCtrlT?.();
    playback.reset();

    playback.playEvents([
      { type: "assistant_start", historyEntryId: "assistant-2" },
      {
        type: "assistant_partial",
        historyEntryId: "assistant-2",
        snapshot: { text: "", thinking: "hmm", hasTextStarted: false, hasAnyThinking: true },
      },
    ]);

    const insertedAfter = playback.calls.added.filter(
      (entry) => entry.model.type === "assistant_partial",
    );
    expect(insertedAfter.length).toBe(1);
  });

  it("toggles thinking visibility and announces status", () => {
    const playback = createPlaybackHarness();
    const handlers = playback.controller.getInputHandlers();

    handlers.onCtrlT?.();
    handlers.onCtrlT?.();

    expect(playback.calls.thinkingVisibility).toEqual([true, false]);
    expect(playback.calls.systemMessages).toEqual([
      { text: "thoughts visible", kind: "success" },
      { text: "thoughts hidden", kind: "success" },
    ]);
  });

  it("routes tool ui events and finalizes after playback", async () => {
    const playback = createPlaybackHarness();

    await playback.playTurn([
      {
        type: "tool_ui",
        uiEvent: {
          type: "write_blocked",
          toolCallId: "write-1",
          path: "notes.txt",
          headerTarget: "notes.txt",
          reason: "blocked",
        },
      },
    ]);

    expect(playback.calls.toolUiEvents).toHaveLength(1);
    expect(playback.calls.toolUiFinalize).toEqual(["interrupted"]);
  });

  it("maps notice severity to system messages", () => {
    const playback = createPlaybackHarness();

    playback.playEvents([{ type: "notice", severity: "warn", text: "heads up" }]);

    expect(playback.calls.systemMessages).toEqual([{ text: "heads up", kind: "warn" }]);
  });
});
