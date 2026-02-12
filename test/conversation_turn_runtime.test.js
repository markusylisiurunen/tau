import { describe, expect, it } from "vitest";
import { ConversationTurnRuntime } from "../dist/core/runtime/conversation_turn_runtime.js";

describe("ConversationTurnRuntime", () => {
  it("streams events in order and reports non-aborted completion", async () => {
    const emitted = [
      { type: "notice", severity: "info", text: "first" },
      { type: "notice", severity: "warn", text: "second" },
      { type: "notice", severity: "error", text: "third" },
    ];

    const session = {
      async *events(signal) {
        for (const event of emitted) {
          if (signal.aborted) {
            break;
          }
          yield event;
        }
      },
    };

    const runtime = new ConversationTurnRuntime(session);
    const received = [];

    expect(runtime.isRunning).toBe(false);
    const result = await runtime.run(async (event) => {
      received.push(event.text);
    });

    expect(result).toEqual(expect.objectContaining({ aborted: false }));
    expect(received).toEqual(["first", "second", "third"]);
    expect(runtime.isRunning).toBe(false);
  });

  it("prevents concurrent runs", async () => {
    let release;
    const blocked = new Promise((resolve) => {
      release = resolve;
    });

    const session = {
      async *events() {
        await blocked;
        yield { type: "notice", severity: "info", text: "released" };
      },
    };

    const runtime = new ConversationTurnRuntime(session);
    const firstRun = runtime.run(() => {});

    expect(runtime.isRunning).toBe(true);
    await expect(runtime.run(() => {})).rejects.toThrow("conversation turn is already running");

    release();
    await firstRun;
    expect(runtime.isRunning).toBe(false);
  });

  it("interrupts the active run and reports aborted status", async () => {
    const session = {
      async *events(signal) {
        yield { type: "notice", severity: "info", text: "tick" };
        while (!signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      },
    };

    const runtime = new ConversationTurnRuntime(session);
    let seen = 0;

    const result = await runtime.run((event) => {
      if (event.type === "notice") {
        seen += 1;
      }
      runtime.interrupt();
    });

    expect(seen).toBe(1);
    expect(result).toEqual(expect.objectContaining({ aborted: true }));
    expect(runtime.isRunning).toBe(false);
  });
});
